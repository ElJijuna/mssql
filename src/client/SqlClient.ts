import sql from 'mssql';
import {
  createDebugEntry,
  type QueryOptions,
  type QueryRunner,
  resolveLogger,
  type SqlDebugOption,
} from '../debug/debug';
import { SqlClientError } from '../errors/SqlClientError';
import type { SqlClientEvents, SqlOperation } from '../events/events';
import { TypedEmitter } from '../events/TypedEmitter';
import { type BatchOptions, describeError, poolConnection, rollbackQuietly } from './batch';
import {
  type CommandContext,
  deleteCommand,
  findOneCommand,
  insertCommand,
  insertManyCommand,
  mergeCommand,
  selectCommand,
  updateCommand,
} from './commands';
import type { MergeOptions } from './merge';
import { type SqlIsolationLevel, SqlTransaction, type TransactionOptions } from './SqlTransaction';
import type { FindOneOptions, SelectOptions } from './select';
import type { SqlWhere } from './statements';
import type { InsertManyResult, MergeResult, SqlClientConfig, SqlRow } from './types';

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

const ISOLATION_LEVELS: Record<SqlIsolationLevel, sql.IIsolationLevel> = {
  readUncommitted: sql.ISOLATION_LEVEL.READ_UNCOMMITTED,
  readCommitted: sql.ISOLATION_LEVEL.READ_COMMITTED,
  repeatableRead: sql.ISOLATION_LEVEL.REPEATABLE_READ,
  serializable: sql.ISOLATION_LEVEL.SERIALIZABLE,
  snapshot: sql.ISOLATION_LEVEL.SNAPSHOT,
};

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
  private readonly context: CommandContext;
  private poolPromise: Promise<sql.ConnectionPool> | undefined;
  private queryId = 0;
  private transactionId = 0;

  public constructor(config: SqlClientConfig, options: SqlClientOptions = {}) {
    super();
    this.config = config;
    this.options = options;
    this.context = {
      runner: (operation, queryOptions) => this.runner(operation, queryOptions, null),
      rowFailure: (event) => {
        this.emit('rowFailure', event);
      },
      request: async () => (await this.connect()).request(),
      connection: async () => poolConnection(await this.connect()),
    };
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
  private runner(
    operation: SqlOperation,
    options: QueryOptions,
    transactionId: number | null,
  ): QueryRunner {
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
      const event = {
        id: ++this.queryId,
        operation,
        transactionId,
        sql: entry.sql,
        params: entry.params,
      };

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
   * Runs `work` in a transaction: commits when it resolves, rolls back when it throws (and
   * rethrows). Resolves with whatever `work` returns.
   *
   * `tx` has the same helpers as the client (`insert`, `insertMany`, `merge`, `update`,
   * `delete`) plus `tx.request()` for raw queries. Batch helpers inside a transaction use
   * savepoints, so a failed `insertMany` in `'rollback'` mode only undoes its own rows; if you
   * catch its error the transaction can still commit the rest.
   *
   * @param work - Receives the transaction. Always `await` its operations.
   * @param options - See {@link TransactionOptions}.
   *
   * @example
   * const orderId = await client.transaction(async (tx) => {
   *   const id = await tx.insert('dbo.Orders', { customerId: 7, total: t.decimal(99.9, 10, 2) });
   *   await tx.insertMany('dbo.OrderLines', lines.map((line) => ({ ...line, orderId: id })));
   *   await tx.update('dbo.Customers', { lastOrderId: id }, { id: 7 });
   *   return id;
   * });
   */
  public async transaction<TResult>(
    work: (tx: SqlTransaction) => Promise<TResult>,
    options: TransactionOptions = {},
  ): Promise<TResult> {
    const pool = await this.connect();
    const transaction = pool.transaction();
    const transactionId = ++this.transactionId;

    await transaction.begin(
      options.isolationLevel ? ISOLATION_LEVELS[options.isolationLevel] : undefined,
    );

    const start = performance.now();
    const tx = new SqlTransaction(transaction, transactionId, {
      runner: (operation, queryOptions, id) => this.runner(operation, queryOptions, id),
      rowFailure: (event) => {
        this.emit('rowFailure', event);
      },
    });

    this.emit('transactionBegin', { transactionId });

    try {
      const result = await work(tx);

      await tx.settle();
      tx.finish();
      await transaction.commit();
      this.emit('transactionCommit', { transactionId, durationMs: performance.now() - start });

      return result;
    } catch (error) {
      await tx.settle();
      tx.finish();
      await rollbackQuietly(async () => transaction.rollback());
      this.emit('transactionRollback', {
        transactionId,
        durationMs: performance.now() - start,
        error,
      });

      throw error;
    }
  }

  /**
   * Reads the rows matching `where` (every row when omitted).
   *
   * `where` uses the same rules as {@link SqlClient.update}: equalities joined with `AND`, `null`
   * → `IS NULL`, arrays → `IN (…)`. Type the rows with the generic parameter.
   *
   * @param table - Table or view name, optionally schema-qualified (`dbo.Users`).
   * @param where - Filter. See {@link SqlWhere}.
   * @param options - Columns, order and paging. See {@link SelectOptions}.
   * @returns The matching rows (an empty array when none match).
   *
   * @example
   * interface User { id: number; name: string }
   *
   * const page = await client.select<User>(
   *   'dbo.Users',
   *   { active: true, role: ['admin', 'editor'] },
   *   { columns: ['id', 'name'], orderBy: { name: 'asc' }, limit: 20, offset: 40 },
   * );
   */
  public async select<TRow extends object = SqlRow>(
    table: string,
    where: SqlWhere = {},
    options: SelectOptions = {},
  ): Promise<TRow[]> {
    return selectCommand<TRow>(this.context, table, where, options);
  }

  /**
   * Reads the first row matching `where`, or `null` when none match (`SELECT TOP (1)`).
   * Use `orderBy` to decide which row wins when several match.
   *
   * @param table - Table or view name, optionally schema-qualified (`dbo.Users`).
   * @param where - Filter. See {@link SqlWhere}.
   * @param options - Columns and order. See {@link FindOneOptions}.
   *
   * @example
   * const user = await client.findOne<User>('dbo.Users', { email: 'ana@example.com' });
   * if (!user) throw new NotFoundError();
   */
  public async findOne<TRow extends object = SqlRow>(
    table: string,
    where: SqlWhere = {},
    options: FindOneOptions = {},
  ): Promise<TRow | null> {
    return findOneCommand<TRow>(this.context, table, where, options);
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
    return insertCommand(this.context, table, row, options);
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
    return insertManyCommand(this.context, table, rows, options);
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
    return mergeCommand(this.context, table, rows, options);
  }

  /**
   * Updates the rows matching `where` and returns how many were affected.
   *
   * `where` is a set of column/value equalities joined with `AND` (`null` matches `IS NULL`,
   * arrays match `IN (…)`). It must not be empty, so a whole table can't be updated by accident.
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
    where: SqlWhere,
    options: QueryOptions = {},
  ): Promise<number> {
    return updateCommand(this.context, table, values, where, options);
  }

  /**
   * Deletes the rows matching `where` and returns how many were removed.
   *
   * `where` is a set of column/value equalities joined with `AND` (`null` matches `IS NULL`,
   * arrays match `IN (…)`). It must not be empty, so a whole table can't be emptied by accident.
   *
   * @param table - Table name, optionally schema-qualified (`dbo.Users`).
   * @param where - Columns identifying the rows to delete.
   * @param options - See {@link QueryOptions}.
   * @returns Number of rows deleted.
   *
   * @example
   * await client.delete('dbo.Sessions', { userId: 42 }); // → 3
   */
  public async delete(table: string, where: SqlWhere, options: QueryOptions = {}): Promise<number> {
    return deleteCommand(this.context, table, where, options);
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
