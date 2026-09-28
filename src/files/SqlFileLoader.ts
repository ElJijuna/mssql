import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqlClientError } from '../errors/SqlClientError';
import { analyzeSql, type SqlAnalysis } from '../sql/analyze';

/**
 * A SQL file read from disk and analyzed.
 *
 * @internal
 */
export interface SqlFile {
  /** Path as the caller wrote it (with `.sql` added when missing). */
  name: string;
  /** Absolute path on disk. */
  path: string;
  /** File contents. */
  text: string;
  analysis: SqlAnalysis;
}

/**
 * Reads SQL files relative to a base directory and caches them.
 *
 * @internal
 */
export class SqlFileLoader {
  private readonly dir: string | undefined;
  private readonly cache = new Map<string, Promise<SqlFile>>();

  public constructor(
    dir: string | URL | undefined,
    private readonly useCache: boolean,
  ) {
    this.dir =
      dir === undefined ? undefined : typeof dir === 'string' ? resolve(dir) : fileURLToPath(dir);
  }

  /**
   * Resolves `file` against the base directory. With a base directory, paths may not escape it.
   */
  public resolve(file: string): { name: string; path: string } {
    const name = extname(file) === '' ? `${file}.sql` : file;

    if (this.dir === undefined) {
      return { name, path: resolve(name) };
    }

    const path = resolve(this.dir, name);
    const inside = relative(this.dir, path);

    if (inside.startsWith('..') || isAbsolute(inside)) {
      throw new SqlClientError(`SQL file "${file}" is outside the sqlDir "${this.dir}"`);
    }

    return { name, path };
  }

  /**
   * Reads, analyzes and (when caching) remembers a file.
   */
  public async load(file: string): Promise<SqlFile> {
    const { name, path } = this.resolve(file);
    const cached = this.useCache ? this.cache.get(path) : undefined;

    if (cached) {
      return cached;
    }

    const loading = (async () => {
      try {
        return await this.read(name, path);
      } catch (error) {
        // A failed read is not cached, so a fixed file can be read again.
        this.cache.delete(path);

        throw error;
      }
    })();

    if (this.useCache) {
      this.cache.set(path, loading);
    }

    return loading;
  }

  private async read(name: string, path: string): Promise<SqlFile> {
    let text: string;

    try {
      const raw = await readFile(path, 'utf8');

      text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    } catch (error) {
      const reason =
        (error as { code?: unknown }).code === 'ENOENT' ? 'not found' : 'could not be read';

      throw new SqlClientError(`SQL file "${name}" ${reason} (${path})`, { cause: error });
    }

    const analysis = analyzeSql(text);

    if (analysis.hasBatchSeparator) {
      throw new SqlClientError(
        `SQL file "${name}" contains GO batch separators; queryFile runs a single batch`,
      );
    }

    return { name, path, text, analysis };
  }
}
