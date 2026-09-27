import sql from 'mssql';
import {
  createDebugEntry,
  type QueryOptions,
  type QueryRunner,
  resolveLogger,
  type SqlDebugOption,
} from '../debug/debug';
import { BatchRowError } from '../errors/BatchRowError';
import { SqlClientError } from '../errors/SqlClientError';
import type { SqlClientEvents, SqlOperation } from '../events/events';
import { TypedEmitter } from '../events/TypedEmitter';
import { quoteIdentifier } from '../utils/quoteIdentifier';
import {
  type BatchOptions,
  type BatchOutcome,
  describeError,
  type ExecuteBatchParams,
  executeBatch,
  type RowAction,
  type RowFailure,
  track,
} from './batch';
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
 * Client-level options.
 */
export interface SqlClientOptions {
  /**
   * Print the SQL of every helper call before it is sent. `true` uses `console.debug`; pass a
   * function to route entries to your own logger. Each call can override it with its own `debug`.
   *
   * @example
   * new SqlClient(config, { debug: process.env.NODE_ENV === 'development' });
   */
  debug?: SqlDebugOption;
}

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
 * Thin wrapper around an `mssql` connection pool with helper methods.
 *
 * It is also an event emitter: subscribe with `on` / `once` / `off` to observe connections,
 * queries, successes and failures. See {@link SqlClientEvents}.
 *
 * @example
 * client
 *   .on('success', ({ operation, durationMs }) => metrics.timing(operation, durationMs))
 *   .on('failure', ({ operation, sql, error }) => logger.error({ operation, sql, error }))
 *   .on('rowFailure', ({ index, number, message }) => logger.warn({ index, number, message }));
 */
export class SqlClient extends TypedEmitter<SqlClientEvents> {
  private readonly config: SqlClientConfig;
  private readonly options: SqlClientOptions;
  private poolPromise: Promise<sql.ConnectionPool> | undefined;
  private queryId = 0;

  public constructor(config: SqlClientConfig, options: SqlClientOptions = {}) {
    super();
    this.config = config;
    this.options = options;
  }

  /**
   * Opens the connection pool. Safe to call multiple times; the pool is created once.
   */
  public async connect(): Promise<sql.ConnectionPool> {
    this.poolPromise ??= this.openPool();

    return this.poolPromise;
  }

  /**
   * Creates the function every helper uses to send SQL: prints it when debug is on and emits the
   * `query`, `success` and `failure` events.
   */
  private runner(operation: SqlOperation, options: QueryOptions): QueryRunner {
    const logger = resolveLogger(this.options.debug, options.debug);

    return async (request, text) => {
      const observed =
        logger !== null ||
        this.hasListeners('query') ||
        this.hasListeners('success') ||
        this.hasListeners('failure');

      if (!observed) {
        return request.query<Record<string, unknown>>(text);
      }

      const entry = createDebugEntry(operation, request, text);
      const event = { id: ++this.queryId, operation, sql: entry.sql, params: entry.params };

      logger?.(entry);
      this.emit('query', event);

      const start = performance.now();

      try {
        const result = await request.query<Record<string, unknown>>(text);

        this.emit('success', {
          ...event,
          durationMs: performance.now() - start,
          rowsAffected: result.rowsAffected,
        });

        return result;
      } catch (error) {
        this.emit('failure', {
          ...event,
          durationMs: performance.now() - start,
          error,
          number: describeError(error).number,
        });

        throw error;
      }
    };
  }

  /**
   * Runs a batch helper and emits `rowFailure` for every failed row, in both `onError` modes.
   */
  private async runBatch(
    operation: SqlOperation,
    params: ExecuteBatchParams,
  ): Promise<BatchOutcome> {
    try {
      const outcome = await executeBatch(params);

      for (const failure of outcome.failures) {
        this.emit('rowFailure', { ...failure, operation });
      }

      return outcome;
    } catch (error) {
      if (error instanceof BatchRowError) {
        this.emit('rowFailure', {
          operation,
          index: error.index,
          row: error.row,
          number: error.number,
          message: error.sqlMessage,
        });
      }

      throw error;
    }
  }

  private async openPool(): Promise<sql.ConnectionPool> {
    const start = performance.now();

    try {
      const pool = await new sql.ConnectionPool(this.config).connect();

      this.emit('connect', { durationMs: performance.now() - start });

      return pool;
    } catch (error) {
      this.poolPromise = undefined;
      this.emit('connectFailure', { durationMs: performance.now() - start, error });

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
   * @param options - See {@link QueryOptions}.
   * @returns The generated identity, or `null` when the table has no identity column.
   *
   * @example
   * const id = await client.insert('dbo.Users', {
   *   name: t.nvarchar('Ana', 100),
   *   email: 'ana@example.com',
   * });
   */
  public async insert(
    table: string,
    row: SqlRow,
    options: QueryOptions = {},
  ): Promise<number | null> {
    const pool = await this.connect();
    const request = pool.request();
    const insert = buildInsertStatement(quoteIdentifier(table), row, request);
    const result = await this.runner('insert', options)(
      request,
      `${insert} SELECT SCOPE_IDENTITY() AS id;`,
    );
    const id = result.recordset[0]?.id;

    return typeof id === 'number' ? id : null;
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
    const { outcomes, failures } = await this.runBatch('insertMany', {
      pool: await this.connect(),
      rows,
      options,
      query: this.runner('insertMany', options),
      build: (row, request, offset) =>
        `${buildInsertStatement(target, row, request, offset)} ${track('inserted', 'SCOPE_IDENTITY()')}`,
    });

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

    const { outcomes, failures } = await this.runBatch('merge', {
      pool: await this.connect(),
      rows,
      options,
      query: this.runner('merge', options),
      build: buildMergeStatement(table, keys, options.update),
      validate: missingKey(keys),
    });

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
   * @param options - See {@link QueryOptions}.
   * @returns Number of rows updated.
   *
   * @example
   * await client.update('dbo.Users', { name: 'Ana María' }, { id: 42 }); // → 1
   */
  public async update(
    table: string,
    values: SqlRow,
    where: SqlRow,
    options: QueryOptions = {},
  ): Promise<number> {
    const whereKeys = requireWhere('update', where);

    if (Object.keys(values).length === 0) {
      throw new SqlClientError('update requires at least one column to set');
    }

    const pool = await this.connect();
    const request = pool.request();
    const set = bindRow(values, request, 0);
    const match = bindRow(where, request, set.size);
    const assignments = [...set].map(([column, param]) => `${quoteIdentifier(column)} = ${param}`);
    const result = await this.runner('update', options)(
      request,
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
   * @param options - See {@link QueryOptions}.
   * @returns Number of rows deleted.
   *
   * @example
   * await client.delete('dbo.Sessions', { userId: 42 }); // → 3
   */
  public async delete(table: string, where: SqlRow, options: QueryOptions = {}): Promise<number> {
    const whereKeys = requireWhere('delete', where);
    const pool = await this.connect();
    const request = pool.request();
    const match = bindRow(where, request, 0);
    const result = await this.runner('delete', options)(
      request,
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
    this.emit('close', {});
  }
}

const requireWhere = (operation: string, where: SqlRow): string[] => {
  const keys = Object.keys(where);

  if (keys.length === 0) {
    throw new SqlClientError(`${operation} requires a non-empty \`where\``);
  }

  return keys;
};
