import sql from 'mssql';
import {
  createDebugEntry,
  type QueryOptions,
  type QueryRunner,
  resolveLogger,
  type SqlDebugOption,
} from '../debug/debug';
import { SqlConnectionError } from '../errors/SqlConnectionError';
import { normalizeError } from '../errors/SqlQueryError';
import type { SqlClientEvents, SqlOperation } from '../events/events';
import { TypedEmitter } from '../events/TypedEmitter';
import { SqlFileLoader } from '../files/SqlFileLoader';
import type { SqlQueryCatalog } from '../files/SqlQueryCatalog';
import type { SqlParams } from '../sql/bindNamed';
import type { SqlFragment } from '../sql/fragment';
import type { SqlIdentity } from '../types/identity';
import { SqlIncrement } from '../types/SqlParam';
import { type BatchOptions, describeError, poolConnection, rollbackQuietly } from './batch';
import { type CallScope, createCallGuard, createScope, pause } from './cancellation';
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
import {
  type ExecOptions,
  type ExecOutput,
  type ExecOutputValues,
  type ExecResult,
  execCommand,
} from './exec';
import type { MergeOptions } from './merge';
import { type PageOptions, pageCommand, type SqlPage } from './page';
import {
  normalizeQuery,
  type QueryInput,
  type QueryResult,
  queryCommand,
  queryFileCommand,
  queryNamedCommand,
  type RawQueryOptions,
} from './query';
import {
  errorNumber,
  isRetryable,
  type RetryOption,
  type RetryPolicy,
  resolveRetry,
  retryDelay,
} from './retry';
import type { ReturningOptions } from './returning';
import { type SqlIsolationLevel, SqlTransaction, type TransactionOptions } from './SqlTransaction';
import type { FindOneOptions, SelectOptions } from './select';
import { SqlSet, type SqlSetOptions } from './set';
import type { SqlWhere } from './statements';
import type { InsertManyResult, MergeResult, SqlClientConfig, SqlRow } from './types';

/**
 * Client-level options.
 */
export interface SqlClientOptions {
  /** Preloaded named SQL queries for queryNamed(). */
  sqlCatalog?: SqlQueryCatalog;
  /**
   * Whether `close()` closes the underlying pool. Defaults to `true` for a configuration and
   * `false` for an existing pool. Set `true` only when transferring ownership of an external pool
   * to this client; other users of that pool must stop before closing it.
   */
  ownsPool?: boolean;
  /**
   * Print the SQL of every helper call before it is sent. `true` uses `console.debug`; pass a
   * function to route entries to your own logger. Each call can override it with its own `debug`.
   *
   * @example
   * new SqlClient(config, { debug: process.env.NODE_ENV === 'development' });
   */
  debug?: SqlDebugOption;
  /**
   * Base directory for {@link SqlClient.queryFile}. Relative file paths resolve against it and
   * may not escape it. Prefer a URL so it doesn't depend on the working directory.
   *
   * @example
   * new SqlClient(config, { sqlDir: new URL('./sql', import.meta.url) });
   */
  sqlDir?: string | URL;
  /**
   * Keep SQL files in memory after the first read. Defaults to `true`; turn it off in development
   * to pick up edits without restarting.
   */
  cacheSqlFiles?: boolean;
  /**
   * Retry transient errors (deadlocks, Azure SQL failovers, busy service…) with exponential
   * backoff. On by default for `select`, `findOne`, `insert`, `update`, `delete`, `insertMany` and
   * `merge`; `false` turns it off. `exec`, `query`, `queryFile` and `transaction` only retry when
   * the call asks for it. See {@link RetryOptions}.
   */
  retry?: RetryOption;
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
  private readonly source: SqlClientConfig | sql.ConnectionPool;
  private readonly ownsPool: boolean;
  private readonly options: SqlClientOptions;
  private readonly context: CommandContext;
  private readonly sqlFiles: SqlFileLoader;
  private poolPromise: Promise<sql.ConnectionPool> | undefined;
  private queryId = 0;
  private transactionId = 0;

  /**
   * Accepts a configuration or an existing pool (connected or not). An existing pool is borrowed
   * by default: its owner remains responsible for closing it.
   */
  public constructor(source: SqlClientConfig | sql.ConnectionPool, options: SqlClientOptions = {}) {
    super();
    this.source = source;
    this.ownsPool = options.ownsPool ?? !('connect' in source);
    this.options = options;
    this.sqlFiles = new SqlFileLoader(options.sqlDir, options.cacheSqlFiles ?? true);
    this.context = {
      sqlFile: async (file) => this.sqlFiles.load(file),
      sqlNamed: options.sqlCatalog?.loadQuery.bind(options.sqlCatalog),
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
   * Creates the function every helper uses to send SQL: prints it when debug is on, emits the
   * `query`, `success` and `failure` events, and enforces the call's `signal` and `timeout`.
   * Create it before connecting, so the timeout also covers waiting for a connection.
   */
  private runner(
    operation: SqlOperation,
    options: QueryOptions,
    transactionId: number | null,
    scope?: CallScope,
  ): QueryRunner {
    const logger = resolveLogger(this.options.debug, options.debug);
    const guard = createCallGuard(operation, options, scope);

    return async (request, text, run = async (req) => req.query<Record<string, unknown>>(text)) => {
      guard.check();

      const execute = async () => {
        try {
          return await guard.run(request, run(request));
        } catch (error) {
          throw normalizeError(error, operation);
        }
      };
      const observed =
        logger !== null ||
        this.hasListeners('query') ||
        this.hasListeners('success') ||
        this.hasListeners('failure');

      if (!observed) {
        return execute();
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
        const result = await execute();

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
   * Runs a helper, retrying transient errors according to the client and call `retry` options.
   * `signal` and `timeout` span every attempt, including the waits between them.
   */
  private async call<TResult, TOptions extends QueryOptions>(
    operation: SqlOperation,
    options: TOptions,
    run: (ctx: CommandContext, options: TOptions) => Promise<TResult>,
    policyOptions: { retryByDefault?: boolean; connectionOnly?: boolean } = {},
  ): Promise<TResult> {
    try {
      return await this.callWithRetry(
        operation,
        options,
        async (ctx, queryOptions) => {
          try {
            return await run(ctx, queryOptions);
          } catch (error) {
            throw normalizeError(error, operation);
          }
        },
        policyOptions,
      );
    } catch (error) {
      throw normalizeError(error, operation);
    }
  }

  private async callWithRetry<TResult, TOptions extends QueryOptions>(
    operation: SqlOperation,
    options: TOptions,
    run: (ctx: CommandContext, options: TOptions) => Promise<TResult>,
    { retryByDefault = true, connectionOnly = false } = {},
  ): Promise<TResult> {
    const policy = resolveRetry(this.options.retry, options.retry, retryByDefault);

    if (!policy) {
      return run(this.context, options);
    }

    const { signal, timeout, ...rest } = options;
    const scope = createScope(operation, { signal, timeout });
    const ctx: CommandContext = {
      ...this.context,
      runner: (op, queryOptions) => this.runner(op, queryOptions, null, scope),
      rowRetry: {
        attempts: policy.attempts,
        isTransient: (failure, attempt) => isRetryable(failure, attempt, policy),
        wait: async (attempt, failures) => {
          const [first] = failures;

          await this.waitToRetry(
            operation,
            attempt,
            policy,
            scope,
            first,
            failures.map(({ index }) => index),
          );
        },
      },
    };

    // The scope enforces signal/timeout across attempts, so the attempts don't get their own clock.
    return this.retrying(operation, policy, scope, connectionOnly, async () =>
      run(ctx, rest as TOptions),
    );
  }

  private async retrying<TResult>(
    operation: SqlOperation | 'transaction',
    policy: RetryPolicy,
    scope: CallScope,
    connectionOnly: boolean,
    attemptOnce: () => Promise<TResult>,
  ): Promise<TResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await attemptOnce();
      } catch (error) {
        if (attempt > policy.attempts || !isRetryable(error, attempt, policy, connectionOnly)) {
          throw error;
        }

        await this.waitToRetry(operation, attempt, policy, scope, error);
      }
    }
  }

  private async waitToRetry(
    operation: SqlOperation | 'transaction',
    attempt: number,
    policy: RetryPolicy,
    scope: CallScope,
    error: unknown,
    rows?: number[],
  ): Promise<void> {
    const delayMs = retryDelay(attempt, policy);

    this.emit('retry', {
      operation,
      attempt,
      delayMs,
      error,
      number: errorNumber(error),
      ...(rows ? { rows } : {}),
    });
    await pause(delayMs, scope);
  }

  private async openPool(): Promise<sql.ConnectionPool> {
    const start = performance.now();

    try {
      const pool = 'connect' in this.source ? this.source : new sql.ConnectionPool(this.source);

      if (!pool.connected) {
        await pool.connect();
      }

      this.emit('connect', { durationMs: performance.now() - start });

      return pool;
    } catch (error) {
      this.poolPromise = undefined;
      this.emit('connectFailure', { durationMs: performance.now() - start, error });

      throw new SqlConnectionError('Failed to connect to SQL Server', { cause: error });
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
    const scope = createScope('transaction', options);
    const policy = resolveRetry(this.options.retry, options.retry, false);

    if (!policy) {
      return this.runTransaction(work, options, scope);
    }

    return this.retrying('transaction', policy, scope, false, async () =>
      this.runTransaction(work, options, scope),
    );
  }

  private async runTransaction<TResult>(
    work: (tx: SqlTransaction) => Promise<TResult>,
    options: TransactionOptions,
    scope: CallScope,
  ): Promise<TResult> {
    // Checks the signal and deadline before (re)starting.
    createCallGuard('transaction', {}, scope);

    const pool = await this.connect();
    const transaction = pool.transaction();
    const transactionId = ++this.transactionId;

    try {
      await transaction.begin(
        options.isolationLevel ? ISOLATION_LEVELS[options.isolationLevel] : undefined,
      );
    } catch (error) {
      throw normalizeError(error, 'transaction');
    }

    const start = performance.now();
    const tx = new SqlTransaction(transaction, transactionId, {
      sqlFile: async (file) => this.sqlFiles.load(file),
      sqlNamed: this.context.sqlNamed,
      runner: (operation, queryOptions, id) => this.runner(operation, queryOptions, id, scope),
      rowFailure: (event) => {
        this.emit('rowFailure', event);
      },
    });

    this.emit('transactionBegin', { transactionId });

    try {
      const result = await work(tx);

      await tx.settle();
      tx.finish();
      // Don't commit a transaction whose signal fired or whose time ran out meanwhile.
      createCallGuard('transaction', {}, scope).check();

      try {
        await transaction.commit();
      } catch (error) {
        throw normalizeError(error, 'transaction');
      }

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
    return this.call('select', options, async (ctx, o) =>
      selectCommand<TRow>(ctx, table, where, o),
    );
  }

  /** Read a forward cursor page with an explicit unique tie-breaker. */
  public async page<TRow extends object = SqlRow>(
    table: string,
    options: PageOptions,
  ): Promise<SqlPage<TRow>> {
    return this.call('page', options, async (ctx, resolved) =>
      pageCommand<TRow>(ctx, table, resolved),
    );
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
    return this.call('findOne', options, async (ctx, o) =>
      findOneCommand<TRow>(ctx, table, where, o),
    );
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
  public async insert<TRow extends object = SqlRow>(
    table: string,
    row: SqlRow,
    options: ReturningOptions,
  ): Promise<TRow[]>;
  public async insert(
    table: string,
    row: SqlRow,
    options?: QueryOptions,
  ): Promise<SqlIdentity | null>;
  public async insert(
    table: string,
    row: SqlRow,
    options: QueryOptions | ReturningOptions = {},
  ): Promise<SqlIdentity | null | SqlRow[]> {
    return this.call('insert', options, async (ctx, o) => insertCommand(ctx, table, row, o));
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
    return this.call(
      'insertMany',
      options,
      async (ctx, o) => insertManyCommand(ctx, table, rows, o),
      {
        connectionOnly: options.onError === 'continue',
      },
    );
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
    return this.call('merge', options, async (ctx, o) => mergeCommand(ctx, table, rows, o), {
      connectionOnly: options.onError === 'continue',
    });
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
  public async update<TRow extends object = SqlRow>(
    table: string,
    values: SqlRow,
    where: SqlWhere,
    options: ReturningOptions,
  ): Promise<TRow[]>;
  public async update(
    table: string,
    values: SqlRow,
    where: SqlWhere,
    options?: QueryOptions,
  ): Promise<number>;
  public async update(
    table: string,
    values: SqlRow,
    where: SqlWhere,
    options: QueryOptions | ReturningOptions = {},
  ): Promise<number | SqlRow[]> {
    return this.call(
      'update',
      options,
      async (ctx, o) => updateCommand(ctx, table, values, where, o),
      { retryByDefault: !Object.values(values).some((value) => value instanceof SqlIncrement) },
    );
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
  public async delete<TRow extends object = SqlRow>(
    table: string,
    where: SqlWhere,
    options: ReturningOptions,
  ): Promise<TRow[]>;
  public async delete(table: string, where: SqlWhere, options?: QueryOptions): Promise<number>;
  public async delete(
    table: string,
    where: SqlWhere,
    options: QueryOptions | ReturningOptions = {},
  ): Promise<number | SqlRow[]> {
    return this.call('delete', options, async (ctx, o) => deleteCommand(ctx, table, where, o));
  }

  /**
   * Executes a stored procedure.
   *
   * Input parameters are passed by name (plain values or {@link t} builders); a leading `@` is
   * optional. OUTPUT parameters go in `options.output` and come back typed in `result.output`.
   *
   * @param procedure - Procedure name, optionally schema-qualified (`dbo.GetOrders`).
   * @param params - Input parameters by name.
   * @param options - OUTPUT parameters and debug. See {@link ExecOptions}.
   * @returns Rows of the first result set, every result set, output values and the return value.
   *
   * @example
   * const { rows, output, returnValue } = await client.exec<Order>(
   *   'dbo.GetCustomerOrders',
   *   { customerId: 7, status: t.nvarchar('open', 20) },
   *   { output: { total: t.int(null) } },
   * );
   * // rows → Order[], output.total → number | null
   */
  public async exec<TRow extends object = SqlRow, TOutput extends ExecOutput = ExecOutput>(
    procedure: string,
    params: SqlRow = {},
    options: ExecOptions<TOutput> = {},
  ): Promise<ExecResult<TRow, ExecOutputValues<TOutput>>> {
    return this.call(
      'exec',
      options,
      async (ctx, o) => execCommand<TRow, TOutput>(ctx, procedure, params, o),
      {
        retryByDefault: false,
      },
    );
  }

  /**
   * Runs raw SQL — for anything the helpers don't cover (joins, ranges, `LIKE`, CTEs, functions…).
   * Three forms, all parameterized, all shown by debug mode and events:
   *
   * - **Tagged template**: every `${value}` becomes a parameter.
   * - **{@link tsql} fragment + options**: the same, when you need `timeout`, `retry`, `debug`…
   * - **Text + named parameters**: every `@name` is bound from `params`.
   *
   * Values can be plain or {@link t} builders; arrays expand so `IN (…)` works. Missing
   * parameters fail before sending; variables you `DECLARE` in the SQL don't count.
   *
   * @example
   * ```ts
   * const { rows } = await client.query<User>`
   *   SELECT id, name FROM dbo.Users WHERE tenantId = ${tenantId} AND id IN (${ids})`;
   *
   * await client.query(tsql`DELETE FROM dbo.Sessions WHERE expiresAt < ${now}`, { timeout: 5_000 });
   *
   * await client.query<User>(
   *   'SELECT id, name FROM dbo.Users WHERE tenantId = @tenantId AND id IN (@ids)',
   *   { tenantId: 7, ids: [1, 2, 3] },
   * );
   * ```
   */
  public async query<TRow extends object = SqlRow>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<QueryResult<TRow>>;
  public async query<TRow extends object = SqlRow>(
    fragment: SqlFragment,
    options?: RawQueryOptions,
  ): Promise<QueryResult<TRow>>;
  public async query<TRow extends object = SqlRow>(
    sql: string,
    params?: SqlParams,
    options?: RawQueryOptions,
  ): Promise<QueryResult<TRow>>;
  public async query<TRow extends object = SqlRow>(
    input: QueryInput,
    ...rest: unknown[]
  ): Promise<QueryResult<TRow>> {
    try {
      const { text, params, options } = normalizeQuery(input, rest);

      return await this.call(
        'query',
        options,
        async (ctx, o) => queryCommand<TRow>(ctx, text, params, o),
        {
          retryByDefault: false,
        },
      );
    } catch (error) {
      throw normalizeError(error, 'query');
    }
  }

  /** Execute a registered SQL query. Retries require explicit per-call opt-in. */
  public async queryNamed<TRow extends object = SqlRow>(
    name: string,
    params: SqlParams = {},
    options: RawQueryOptions = {},
  ): Promise<QueryResult<TRow>> {
    return this.call(
      'queryNamed',
      options,
      async (ctx, resolved) => queryNamedCommand<TRow>(ctx, name, params, resolved),
      { retryByDefault: false },
    );
  }

  /**
   * Runs the SQL in a `.sql` file, exactly like {@link SqlClient.query}.
   *
   * The path is relative to the `sqlDir` client option (or the working directory without it);
   * the `.sql` extension is optional. Files are read once and cached (see `cacheSqlFiles`).
   *
   * @param file - Path to the file, e.g. `'users/get-by-tenant.sql'` or `'users/get-by-tenant'`.
   * @param params - Parameters by name; a leading `@` is optional.
   * @param options - See {@link RawQueryOptions}.
   *
   * @example
   * ```ts
   * // sql/users/get-by-tenant.sql:
   * //   SELECT id, name FROM dbo.Users WHERE tenantId = @tenantId AND status IN (@statuses);
   *
   * const client = new SqlClient(config, { sqlDir: new URL('./sql', import.meta.url) });
   * const { rows } = await client.queryFile<User>('users/get-by-tenant', {
   *   tenantId: 7,
   *   statuses: ['active', 'pending'],
   * });
   * ```
   */
  public async queryFile<TRow extends object = SqlRow>(
    file: string,
    params: SqlParams = {},
    options: RawQueryOptions = {},
  ): Promise<QueryResult<TRow>> {
    return this.call(
      'queryFile',
      options,
      async (ctx, o) => queryFileCommand<TRow>(ctx, file, params, o),
      {
        retryByDefault: false,
      },
    );
  }

  /**
   * A set of rows of `table` identified by `key`, to compare with a JavaScript list using the same
   * operations as `Set` (`difference`, `intersection`, `union`, `symmetricDifference`,
   * `isSubsetOf`, `isSupersetOf`, `isDisjointFrom`) plus `missing` (list items not in the table).
   *
   * The list can hold keys or objects and is sent as a single JSON parameter, so it isn't limited
   * to 2100 values; the comparison runs in SQL Server and only the result comes back. Text keys
   * follow the column's collation unless `caseSensitive` is set; `NULL` keys are ignored.
   *
   * @example
   * ```ts
   * const users = client.set<User>('dbo.Users', { key: 'email', where: { tenantId: 7 } });
   *
   * const toDeactivate = await users.difference(incoming);   // in the table, not in the list
   * const toCreate = await users.missing(incoming);          // your items not in the table
   * ```
   */
  public set<TRow extends object = SqlRow>(table: string, options: SqlSetOptions): SqlSet<TRow> {
    return new SqlSet<TRow>(table, options, async (work, queryOptions) =>
      this.call('set', queryOptions, work),
    );
  }

  /**
   * Releases this client's pool reference. Closes the pool only when this client owns it.
   * A later helper call or `connect()` can reconnect/reuse the pool.
   */
  public async close(): Promise<void> {
    if (!this.poolPromise) {
      return;
    }

    const pool = await this.poolPromise;

    this.poolPromise = undefined;

    if (this.ownsPool) {
      try {
        await pool.close();
      } catch (error) {
        throw normalizeError(error, 'close');
      }
    }

    this.emit('close', {});
  }
}
