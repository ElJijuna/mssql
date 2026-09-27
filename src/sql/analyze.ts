/**
 * A `@name` reference found in SQL text.
 *
 * @internal
 */
export interface SqlParameterReference {
  /** Name without `@`, as written. */
  name: string;
  /** Position of `@` in the text. */
  start: number;
  /** Position right after the name. */
  end: number;
}

/**
 * What {@link analyzeSql} found in SQL text.
 *
 * @internal
 */
export interface SqlAnalysis {
  /** Every `@name` reference, excluding `DECLARE`d variables and `EXEC` argument names. */
  references: SqlParameterReference[];
  /** Distinct parameter names the text needs, in order of appearance. */
  required: string[];
  /** The text has `GO` batch separators (not T-SQL; only SSMS/sqlcmd understand them). */
  hasBatchSeparator: boolean;
}

/**
 * Replaces comments, string literals and quoted identifiers with spaces, keeping positions, so the
 * rest of the analysis only sees real T-SQL tokens.
 *
 * @internal
 */
export const maskSql = (text: string): string => {
  const out = [...text];
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      if (out[i] !== '\n') {
        out[i] = ' ';
      }
    }
  };

  let i = 0;

  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '-' && next === '-') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;

      blank(i, stop);
      i = stop;
    } else if (char === '/' && next === '*') {
      // T-SQL block comments nest.
      let depth = 0;
      let j = i;

      while (j < text.length) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth--;
          j += 2;

          if (depth === 0) {
            break;
          }
        } else {
          j++;
        }
      }

      blank(i, j);
      i = j;
    } else if (char === "'" || char === '"' || char === '[') {
      const close = char === '[' ? ']' : char;

      let j = i + 1;

      while (j < text.length) {
        if (text[j] === close) {
          if (text[j + 1] === close) {
            j += 2;
            continue;
          }

          j++;
          break;
        }

        j++;
      }

      blank(i, j);
      i = j;
    } else {
      i++;
    }
  }

  return out.join('');
};

const REFERENCE = /(?<![\p{L}\p{N}_$#@])@([\p{L}_#$][\p{L}\p{N}_$#@]*)/gu;
const WORD_CHAR = /[\p{L}\p{N}_$#@]/u;
const STATEMENT_KEYWORDS = new Set([
  'begin',
  'close',
  'deallocate',
  'declare',
  'delete',
  'end',
  'exec',
  'execute',
  'fetch',
  'if',
  'insert',
  'merge',
  'open',
  'print',
  'raiserror',
  'return',
  'select',
  'set',
  'throw',
  'update',
  'while',
  'with',
]);
/**
 * Walks from `from` until the statement ends (`;` or a statement keyword at depth 0), calling
 * `visit` for every depth-0 character.
 */
const walkStatement = (
  masked: string,
  from: number,
  visit: (index: number, char: string) => void,
): void => {
  let depth = 0;
  let i = from;

  while (i < masked.length) {
    const char = masked.charAt(i);

    if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
    } else if (depth === 0) {
      if (char === ';') {
        return;
      }

      if (/\p{L}/u.test(char) && !WORD_CHAR.test(masked.charAt(i - 1))) {
        let end = i;

        while (end < masked.length && WORD_CHAR.test(masked.charAt(end))) {
          end++;
        }

        if (STATEMENT_KEYWORDS.has(masked.slice(i, end).toLowerCase())) {
          return;
        }

        i = end;
        continue;
      }

      visit(i, char);
    }

    i++;
  }
};
/**
 * Names declared with `DECLARE @a …, @b …` (lower-cased: T-SQL variable names are
 * case-insensitive).
 */
const declaredVariables = (masked: string): Set<string> => {
  const declared = new Set<string>();

  for (const match of masked.matchAll(/\bdeclare\b/giu)) {
    let expectingName = true;

    walkStatement(masked, match.index + match[0].length, (index, char) => {
      if (char === ',') {
        expectingName = true;
      } else if (char === '@' && expectingName) {
        const name = /^@([\p{L}\p{N}_$#@]+)/u.exec(masked.slice(index))?.[1];

        if (name) {
          declared.add(name.toLowerCase());
        }

        expectingName = false;
      } else if (!/\s/u.test(char)) {
        expectingName = false;
      }
    });
  }

  return declared;
};
/**
 * Positions of `@name =` argument names inside `EXEC proc @name = value` (not variables).
 */
const execArgumentNames = (masked: string): Set<number> => {
  const positions = new Set<number>();

  for (const match of masked.matchAll(/\bexec(?:ute)?\b/giu)) {
    walkStatement(masked, match.index + match[0].length, (index, char) => {
      if (char === '@' && /^@[\p{L}_#$][\p{L}\p{N}_$#@]*\s*=(?!=)/u.test(masked.slice(index))) {
        positions.add(index);
      }
    });
  }

  return positions;
};

/**
 * Finds the parameters SQL text expects: every `@name` that isn't a system function (`@@…`), a
 * `DECLARE`d variable, or an `EXEC` argument name, ignoring comments and string literals.
 *
 * @internal
 */
export const analyzeSql = (text: string): SqlAnalysis => {
  const masked = maskSql(text);
  const declared = declaredVariables(masked);
  const execArguments = execArgumentNames(masked);
  const references: SqlParameterReference[] = [];
  const seen = new Set<string>();
  const required: string[] = [];

  for (const match of masked.matchAll(REFERENCE)) {
    const name = match[1] ?? '';
    const key = name.toLowerCase();

    if (declared.has(key) || execArguments.has(match.index)) {
      continue;
    }

    references.push({ name, start: match.index, end: match.index + match[0].length });

    if (!seen.has(key)) {
      seen.add(key);
      required.push(name);
    }
  }

  return {
    references,
    required,
    hasBatchSeparator: /^[ \t]*go(?:[ \t]+\d+)?[ \t]*;?[ \t]*$/imu.test(masked),
  };
};
