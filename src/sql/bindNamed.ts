import type sql from 'mssql';
import { SqlClientError } from '../errors/SqlClientError';
import { bindInput } from '../types/SqlParam';
import type { SqlAnalysis } from './analyze';

/**
 * Parameters for raw SQL, by name (a leading `@` is optional). Values may be plain, {@link t}
 * builders, or arrays — an array expands `@name` into a list for `IN (@name)`.
 */
export type SqlParams = Record<string, unknown>;

const bare = (name: string): string => (name.startsWith('@') ? name.slice(1) : name);
const providedNames = (params: SqlParams): Map<string, string> =>
  new Map(Object.keys(params).map((name) => [bare(name).toLowerCase(), name]));

/**
 * Throws when the SQL references a parameter that `params` doesn't provide.
 *
 * @internal
 */
export const assertParameters = (
  analysis: SqlAnalysis,
  params: SqlParams,
  source: string,
): void => {
  const provided = providedNames(params);
  const missing = analysis.required.filter((name) => !provided.has(name.toLowerCase()));

  if (missing.length > 0) {
    throw new SqlClientError(
      `${source} is missing parameter(s): ${missing.map((name) => `@${name}`).join(', ')}`,
    );
  }
};

/**
 * Binds `params` to `request` by name and returns the SQL to send: identical to `text` unless an
 * array parameter was expanded (`@ids` → `@ids__0, @ids__1, …`; an empty array becomes `NULL`,
 * so `IN (@ids)` matches nothing).
 *
 * @internal
 */
export const bindNamedParameters = (
  request: sql.Request,
  text: string,
  analysis: SqlAnalysis,
  params: SqlParams,
): string => {
  const provided = providedNames(params);
  const expansions = new Map<string, string>();

  for (const [key, name] of provided) {
    const value = params[name];
    const param = bare(name);

    if (!Array.isArray(value)) {
      bindInput(request, param, value);
      continue;
    }

    const list = value.map((item: unknown, index) => {
      const itemName = `${param}__${index}`;

      bindInput(request, itemName, item);

      return `@${itemName}`;
    });

    expansions.set(key, list.length === 0 ? 'NULL' : list.join(', '));
  }

  if (expansions.size === 0) {
    return text;
  }

  let result = text;

  for (const reference of [...analysis.references].reverse()) {
    const list = expansions.get(reference.name.toLowerCase());

    if (list !== undefined) {
      result = result.slice(0, reference.start) + list + result.slice(reference.end);
    }
  }

  return result;
};
