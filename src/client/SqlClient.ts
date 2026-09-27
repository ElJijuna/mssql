import sql from 'mssql';
import { SqlClientError } from '../errors/SqlClientError';
import { quoteIdentifier } from '../utils/quoteIdentifier';
import { type BatchOptions, executeBatch, type RowAction, type RowFailure, track } from './batch';
import { buildMergeStatement, type MergeOptions, missingKey, normalizeKeys } from './merge';
import { bindRow, buildInsertStatement, keyPredicate } from './statements';

/**
 * Configuration accepted by {@link SqlClient}. Same shape as `mssql`'s `config`.
 */
export type SqlClientConfig = sql.config;

/**
 * Column/value pairs for a single row. Keys are column names; values are sent as parameters.
 * Use the {@link t} builders to set an explicit type, otherwise mssql infers it from the value.
 */
export type SqlRow = Record<string, unknown>;

/**
 * Result of {@link SqlClient.insertMany}.
 */
export interface InsertManyResult {
  /** Number of rows inserted. */
  inserted: number;
  /**
   * Generated identities aligned with the input rows. `null` for failed rows or tables without an
   * identity column.
   */
  ids: Array<number | null>;
  /** Rows that failed. Always empty in `'rollback'` mode (it throws instead). */
  failures: RowFailure[];
}

/**
 * Result of {@link SqlClient.merge}.
 */
export interface MergeResult {
  /** Rows that did not exist and were inserted. */
  inserted: number;
  /** Rows that existed and were updated. */
  updated: number;
  /** Rows that existed and were left untouched (`update: false`, or nothing to update). */
  skipped: number;
  /** What happened to each input row, aligned with the input. `null` for failed rows. */
  actions: Array<RowAction | null>;
  /** Identity generated for inserted rows, aligned with the input. `null` otherwise. */
  ids: Array<number | null>;
  /** Rows that failed. Always empty in `'rollback'` mode (it throws instead). */
  failures: RowFailure[];
}

/**
 * Thin wrapper around an `mssql` connection pool that will host the helper methods.
 */
export class SqlClient {
  private readonly config: SqlClientConfig;
  private poolPromise: Promise<sql.ConnectionPool> | undefined;

  public constructor(config: SqlClientConfig) {
    this.config = config;
  }

  /**
   * Opens the connection pool. Safe to call multiple times; the pool is created once.
   */
  public async connect(): Promise<sql.ConnectionPool> {
    this.poolPromise ??= this.openPool();

    return this.poolPromise;
  }

  private async openPool(): Promise<sql.ConnectionPool> {
    try {
      return await new sql.ConnectionPool(this.config).connect();
    } catch (error) {
      this.poolPromise = undefined;

      throw new SqlClientError('Failed to connect to SQL Server', { cause: error });
    }
  }

  /**
   * Inserts a single row and returns the identity value generated for it.
   *
   * Values are sent as parameters (never interpolated) and table/column names are
   * bracket-quoted. The id is read with `SCOPE_IDENTITY()`, so it works on tables
   * with triggers.
   *
   * @param table - Table name, optionally schema-qualified (`dbo.Users`).
   * @param row - Column/value pairs to insert. An empty object inserts `DEFAULT VALUES`.
   * @returns The generated identity, or `null` when the table has no identity column.
   *
   * @example
   * const id = await client.insert('dbo.Users', {
   *   name: t.nvarchar('Ana', 100),
   *   email: 'ana@example.com',
   * });
   */
  public async insert(table: string, row: SqlRow): Promise<number | null> {
    const pool = await this.connect();

    return this.insertOne(pool.request(), table, row);
  }

  private async insertOne(
    request: sql.Request,
    table: string,
    row: SqlRow,
  ): Promise<number | null> {
    const insert = buildInsertStatement(quoteIdentifier(table), row, request);
    const result = await request.query<{ id: number | null }>(
      `${insert} SELECT SCOPE_IDENTITY() AS id;`,
    );

    return result.recordset[0]?.id ?? null;
  }

  /**
   * Inserts many rows in as few round trips as possible and tells you exactly which row failed.
   *
   * Rows are sent in chunks; each chunk is a single T-SQL batch. Rows may have different columns.
   *
   * - `onError: 'rollback'` (default): runs in a transaction. If any row fails, nothing is
   *   persisted and a {@link BatchRowError} is thrown with the failing row's `index`.
   * - `onError: 'continue'`: every row is attempted and this method never throws once connected;
   *   failures are returned in `result.failures`. If a whole chunk is rejected (e.g. an unknown
   *   column, or a value the driver refuses), its rows are retried one by one to find the culprits.
   *
   * @param table - Table name, optionally schema-qualified (`dbo.Users`).
   * @param rows - Rows to insert.
   * @param options - See {@link BatchOptions}.
   *
   * @example
   * try {
   *   const { ids } = await client.insertMany('dbo.Users', [{ name: 'Ana' }, { name: 'Luis' }]);
   * } catch (error) {
   *   if (error instanceof BatchRowError) {
   *     console.error(`Row ${error.index} failed`, error.row, error.sqlMessage);
   *   }
   * }
   */
  public async insertMany(
    table: string,
    rows: SqlRow[],
    options: BatchOptions = {},
  ): Promise<InsertManyResult> {
    const result: InsertManyResult = { inserted: 0, ids: rows.map(() => null), failures: [] };

    if (rows.length === 0) {
      return result;
    }

    const target = quoteIdentifier(table);
    const { outcomes, failures } = await executeBatch(
      await this.connect(),
      rows,
      options,
      (row, request, offset) =>
        `${buildInsertStatement(target, row, request, offset)} ${track('inserted', 'SCOPE_IDENTITY()')}`,
    );

    for (const { i, id } of outcomes) {
      result.ids[i] = id;
      result.inserted += 1;
    }

    result.failures = failures;

    return result;
  }

  /**
   * Inserts rows that don't exist yet and updates the ones that do ("upsert"), matching on `on`.
   *
   * Each row runs `IF EXISTS … UPDATE … ELSE INSERT` under an `UPDLOCK, SERIALIZABLE` lock, so it
   * is safe under concurrency, works on tables with triggers and pinpoints the failing row. It
   * shares chunking and `onError` behavior with {@link SqlClient.insertMany}.
   *
   * @param table - Table name, optionally schema-qualified (`dbo.Users`).
   * @param rows - Rows to merge. Each must include the `on` columns.
   * @param options - See {@link MergeOptions}.
   *
   * @example
   * const { inserted, updated, actions } = await client.merge(
   *   'dbo.Users',
   *   [
   *     { email: 'ana@example.com', name: 'Ana' },
   *     { email: 'luis@example.com', name: 'Luis' },
   *   ],
   *   { on: 'email' },
   * );
   * // actions → ['updated', 'inserted']
   */
  public async merge(table: string, rows: SqlRow[], options: MergeOptions): Promise<MergeResult> {
    const keys = normalizeKeys(options.on);

    if (keys.length === 0) {
      throw new SqlClientError('merge requires at least one key column in `on`');
    }

    keys.forEach(quoteIdentifier);

    const result: MergeResult = {
      inserted: 0,
      updated: 0,
      skipped: 0,
      actions: rows.map(() => null),
      ids: rows.map(() => null),
      failures: [],
    };

    if (rows.length === 0) {
      return result;
    }

    const { outcomes, failures } = await executeBatch(
      await this.connect(),
      rows,
      options,
      buildMergeStatement(table, keys, options.update),
      missingKey(keys),
    );

    for (const { i, action, id } of outcomes) {
      result.actions[i] = action;
      result.ids[i] = id;
      result[action] += 1;
    }

    result.failures = failures;

    return result;
  }

  /**
   * Updates the rows matching `where` and returns how many were affected.
   *
   * `where` is a set of column/value equalities joined with `AND` (`null` matches `IS NULL`). It
   * must not be empty, so a whole table can't be updated by accident.
   *
   * @param table - Table name, optionally schema-qualified (`dbo.Users`).
   * @param values - Columns to set.
   * @param where - Columns identifying the rows to update.
   * @returns Number of rows updated.
   *
   * @example
   * await client.update('dbo.Users', { name: 'Ana María' }, { id: 42 }); // → 1
   */
  public async update(table: string, values: SqlRow, where: SqlRow): Promise<number> {
    const whereKeys = requireWhere('update', where);

    if (Object.keys(values).length === 0) {
      throw new SqlClientError('update requires at least one column to set');
    }

    const pool = await this.connect();
    const request = pool.request();
    const set = bindRow(values, request, 0);
    const match = bindRow(where, request, set.size);
    const assignments = [...set].map(([column, param]) => `${quoteIdentifier(column)} = ${param}`);
    const result = await request.query(
      `UPDATE ${quoteIdentifier(table)} SET ${assignments.join(', ')} WHERE ${keyPredicate(whereKeys, where, match)};`,
    );

    return result.rowsAffected[0] ?? 0;
  }

  /**
   * Deletes the rows matching `where` and returns how many were removed.
   *
   * `where` is a set of column/value equalities joined with `AND` (`null` matches `IS NULL`). It
   * must not be empty, so a whole table can't be emptied by accident.
   *
   * @param table - Table name, optionally schema-qualified (`dbo.Users`).
   * @param where - Columns identifying the rows to delete.
   * @returns Number of rows deleted.
   *
   * @example
   * await client.delete('dbo.Sessions', { userId: 42 }); // → 3
   */
  public async delete(table: string, where: SqlRow): Promise<number> {
    const whereKeys = requireWhere('delete', where);
    const pool = await this.connect();
    const request = pool.request();
    const match = bindRow(where, request, 0);
    const result = await request.query(
      `DELETE FROM ${quoteIdentifier(table)} WHERE ${keyPredicate(whereKeys, where, match)};`,
    );

    return result.rowsAffected[0] ?? 0;
  }

  /**
   * Closes the connection pool if it was opened.
   */
  public async close(): Promise<void> {
    if (!this.poolPromise) {
      return;
    }

    const pool = await this.poolPromise;

    this.poolPromise = undefined;
    await pool.close();
  }
}

const requireWhere = (operation: string, where: SqlRow): string[] => {
  const keys = Object.keys(where);

  if (keys.length === 0) {
    throw new SqlClientError(`${operation} requires a non-empty \`where\``);
  }

  return keys;
};
