import { lstat, readdir } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqlClientError } from '../errors/SqlClientError';
import { analyzeSql } from '../sql/analyze';
import { type SqlFile, SqlFileLoader } from './SqlFileLoader';

export interface SqlQueryCatalogOptions {
  /** Root used for discovery and query names. */
  dir: string | URL;
  /** Relative patterns with *, ** and ?. Defaults to **\/*.sql. */
  pattern?: string | string[];
}

export interface SqlQueryDefinition {
  name: string;
  /** Absolute file path, or null for a query registered from text. */
  path: string | null;
  text: string;
  /** Parameter names inferred by the existing SQL analyzer. */
  parameters: string[];
}

const assertName = (name: string): void => {
  if (
    !name ||
    name.startsWith('/') ||
    name.includes('\\') ||
    name.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new SqlClientError(`Invalid SQL query name "${name}"`);
  }
};
const patternRegex = (pattern: string): RegExp => {
  if (
    !pattern ||
    isAbsolute(pattern) ||
    /^[a-z]:/i.test(pattern) ||
    pattern.includes('\\') ||
    /[{}[\]!]/u.test(pattern) ||
    pattern.split('/').some((part) => part === '..' || part === '.' || !part)
  ) {
    throw new SqlClientError(
      `Invalid SQL catalog pattern "${pattern}"; use relative patterns with *, ** and ?`,
    );
  }

  let expression = '';

  for (let index = 0; index < pattern.length; index++) {
    const char = pattern.charAt(index);

    if (char === '*' && pattern.charAt(index + 1) === '*') {
      if (
        (index > 0 && pattern.charAt(index - 1) !== '/') ||
        (index + 2 < pattern.length && pattern.charAt(index + 2) !== '/')
      ) {
        throw new SqlClientError('** must occupy a complete path segment');
      }

      index++;

      if (pattern.charAt(index + 1) === '/') {
        expression += '(?:[^/]+/)*';
        index++;
      } else {
        expression += '.*';
      }
    } else if (char === '*') {
      expression += '[^/]*';
    } else if (char === '?') {
      expression += '[^/]';
    } else {
      expression += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }

  return new RegExp(`^${expression}$`, 'u');
};

/** Immutable startup snapshot of named SQL queries. No database connection is needed to load it. */
export class SqlQueryCatalog {
  private constructor(private readonly entries: Map<string, SqlFile>) {}

  /** Discover, read and validate all matching files before returning the catalog. Symlinks are skipped. */
  public static async load(options: SqlQueryCatalogOptions): Promise<SqlQueryCatalog> {
    const dir = typeof options.dir === 'string' ? resolve(options.dir) : fileURLToPath(options.dir);
    const patterns =
      typeof options.pattern === 'string' ? [options.pattern] : (options.pattern ?? ['**/*.sql']);

    if (patterns.length === 0) {
      throw new SqlClientError('SQL catalog requires at least one pattern');
    }

    const matchers = patterns.map(patternRegex);
    const found = new Set<string>();
    const walk = async (prefix: string): Promise<void> => {
      const items = await readdir(resolve(dir, prefix), { withFileTypes: true });

      for (const item of items) {
        const path = prefix ? `${prefix}/${item.name}` : item.name;

        if (item.isDirectory()) {
          await walk(path);
        } else if (item.isFile() && matchers.some((matcher) => matcher.test(path))) {
          found.add(path);
        }
      }
    };

    try {
      // Start at literal directory prefixes instead of traversing unrelated project directories.
      const starts = new Set(
        patterns.map((pattern) => {
          const parts = pattern.split('/');
          const directories = parts.slice(0, -1);
          const wildcard = directories.findIndex((part) => /[*?]/u.test(part));

          return directories.slice(0, wildcard === -1 ? directories.length : wildcard).join('/');
        }),
      );

      for (const start of starts) {
        let prefix = '';
        let skip = false;

        for (const segment of start ? start.split('/') : []) {
          prefix = prefix ? `${prefix}/${segment}` : segment;
          const info = await lstat(resolve(dir, prefix));

          if (!info.isDirectory() || info.isSymbolicLink()) {
            skip = true;
            break;
          }
        }

        if (!skip) {
          await walk(start);
        }
      }

      if (found.size === 0) {
        throw new SqlClientError('SQL catalog patterns matched no files');
      }

      const entries = new Map<string, SqlFile>();
      const loader = new SqlFileLoader(dir, false);

      for (const path of [...found].sort()) {
        const name = path.slice(0, path.length - extname(path).length);
        const file = await loader.load(path, false);

        SqlQueryCatalog.register(entries, name, file);
      }

      return new SqlQueryCatalog(entries);
    } catch (error) {
      if (error instanceof SqlClientError) {
        throw error;
      }

      throw new SqlClientError(`Could not load SQL query catalog from "${dir}"`, { cause: error });
    }
  }

  /** Register SQL bundled as strings. Names are explicit and case-sensitive. */
  public static fromQueries(queries: Record<string, string>): SqlQueryCatalog {
    const entries = new Map<string, SqlFile>();

    for (const [name, raw] of Object.entries(queries)) {
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

      SqlQueryCatalog.register(entries, name, { name, path: '', text, analysis: analyzeSql(text) });
    }

    if (entries.size === 0) {
      throw new SqlClientError('SQL catalog requires at least one query');
    }

    return new SqlQueryCatalog(entries);
  }

  private static register(entries: Map<string, SqlFile>, name: string, file: SqlFile): void {
    assertName(name);

    if (entries.has(name)) {
      throw new SqlClientError(`Duplicate SQL query name "${name}"`);
    }

    if (!file.text.trim() || file.analysis.hasBatchSeparator) {
      throw new SqlClientError(
        `SQL query "${name}" requires non-empty SQL without GO batch separators`,
      );
    }

    entries.set(name, { ...file, name });
  }

  /** Names in deterministic lexical order. */
  public names(): string[] {
    return [...this.entries.keys()].sort();
  }

  public has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Inspect SQL and required parameters without connecting to the database. */
  public get(name: string): SqlQueryDefinition {
    const file = this.loadQuery(name);

    return {
      name,
      path: file.path || null,
      text: file.text,
      parameters: [...file.analysis.required],
    };
  }

  /** @internal */
  public loadQuery(name: string): SqlFile {
    const file = this.entries.get(name);

    if (!file) {
      throw new SqlClientError(`Unknown SQL query "${name}"`);
    }

    return {
      ...file,
      analysis: {
        ...file.analysis,
        required: [...file.analysis.required],
        references: file.analysis.references.map((reference) => ({ ...reference })),
      },
    };
  }
}
