import type sql from 'mssql';
import type { QueryOptions, QueryRunner } from '../debug/debug';
import { SqlClientError } from '../errors/SqlClientError';
import { normalizeError } from '../errors/SqlQueryError';
import type { SqlOperation, SqlRowFailureEvent } from '../events/events';
import type { SqlFile } from '../files/SqlFileLoader';
import type { SqlParams } from '../sql/bindNamed';
import type { SqlFragment } from '../sql/fragment';
import type { SqlIdentity } from '../types/identity';
import type { BatchConnection, BatchOptions } from './batch';
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
  type RawQueryOptions,
} from './query';
import type { RetryOption } from './retry';
import type { ReturningOptions } from './returning';
import type { FindOneOptions, SelectOptions } from './select';
import { SqlSet, type SqlSetOptions } from './set';
import type { SqlWhere } from './statements';
import type { InsertManyResult, MergeResult, SqlRow } from './types';

/**
 * Transaction isolation level for {@link SqlClient.transaction}.
 */
export type SqlIsolationLevel =
  | 'readUncommitted'
  | 'readCommitted'
  | 'repeatableRead'
  | 'serializable'
  | 'snapshot';

/**
 * Options for {@link SqlClient.transaction}.
 */
export interface TransactionOptions {
  /** Defaults to the server default (`readCommitted`). */
  isolationLevel?: SqlIsolationLevel;
  /**
   * Cancels the transaction when aborted: the running query is cancelled, the transaction rolls
   * back and `transaction()` rejects with a {@link SqlAbortError}.
   */
  signal?: AbortSignal;
  /**
   * Maximum time for the whole transaction in milliseconds. Every operation inside it is limited
   * by what is left, and the transaction is not committed once the time is up.
   */
  timeout?: number;
  /**
   * Run the whole transaction again when it fails with a transient error (e.g. it was chosen as a
   * deadlock victim). Off by default: `work` may run more than once, so keep side effects outside
   * the database (emails, HTTP calls…) out of it. Operations inside a transaction are never
   * retried on their own.
   */
  retry?: RetryOption;
}

/**
 * What {@link SqlTransaction} needs from its client.
 *
 * @internal
 */
export interface TransactionHooks {
  runner: (operation: SqlOperation, options: QueryOptions, transactionId: number) => QueryRunner;
  rowFailure: (event: SqlRowFailureEvent) => void;
  sqlFile: (file: string) => Promise<SqlFile>;
}

/**
 * The `tx` passed to {@link SqlClient.transaction}. It has the same helpers as the client, but
 * everything runs inside the transaction and is committed or rolled back together.
 *
 * Operations are queued and run one after another (a transaction uses a single connection), so
 * `Promise.all` inside a transaction is safe but not parallel.
 */
export class SqlTransaction {
  private readonly context: CommandContext;
  private queue: Promise<unknown> = Promise.resolve();
  private savepoints = 0;
  private finished = false;

  /**
   * @internal
   */
  public constructor(
    private readonly transaction: sql.Transaction,
    /** Correlates this transaction with the `transactionId` of its events. */
    public readonly id: number,
    hooks: TransactionHooks,
  ) {
    this.context = {
      runner: (operation, options) => hooks.runner(operation, options, id),
      rowFailure: hooks.rowFailure,
      sqlFile: hooks.sqlFile,
      request: async () => Promise.resolve(this.transaction.request()),
      connection: async () => Promise.resolve(this.connection()),
    };
  }

  /**
   * Creates a raw `mssql` request bound to this transaction, for queries the helpers don't cover.
   * Raw requests are not queued: don't run them concurrently with other operations.
   */
  public request(): sql.Request {
    this.assertActive();

    return this.transaction.request();
  }

  /** Transaction version of {@link SqlClient.select}. */
  public async select<TRow extends object = SqlRow>(
    table: string,
    where: SqlWhere = {},
    options: SelectOptions = {},
  ): Promise<TRow[]> {
    return this.enqueue('select', async () =>
      selectCommand<TRow>(this.context, table, where, options),
    );
  }

  /** Read a forward cursor page with an explicit unique tie-breaker. */
  public async page<TRow extends object = SqlRow>(
    table: string,
    options: PageOptions,
  ): Promise<SqlPage<TRow>> {
    return this.enqueue('page', async () => pageCommand<TRow>(this.context, table, options));
  }

  /** Transaction version of {@link SqlClient.findOne}. */
  public async findOne<TRow extends object = SqlRow>(
    table: string,
    where: SqlWhere = {},
    options: FindOneOptions = {},
  ): Promise<TRow | null> {
    return this.enqueue('findOne', async () =>
      findOneCommand<TRow>(this.context, table, where, options),
    );
  }

  /** Transaction version of {@link SqlClient.insert}. */
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
    return this.enqueue('insert', async () => insertCommand(this.context, table, row, options));
  }

  /** Transaction version of {@link SqlClient.insertMany}. */
  public async insertMany(
    table: string,
    rows: SqlRow[],
    options: BatchOptions = {},
  ): Promise<InsertManyResult> {
    return this.enqueue('insertMany', async () =>
      insertManyCommand(this.context, table, rows, options),
    );
  }

  /** Transaction version of {@link SqlClient.merge}. */
  public async merge(table: string, rows: SqlRow[], options: MergeOptions): Promise<MergeResult> {
    return this.enqueue('merge', async () => mergeCommand(this.context, table, rows, options));
  }

  /** Transaction version of {@link SqlClient.update}. */
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
    return this.enqueue('update', async () =>
      updateCommand(this.context, table, values, where, options),
    );
  }

  /** Transaction version of {@link SqlClient.delete}. */
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
    return this.enqueue('delete', async () => deleteCommand(this.context, table, where, options));
  }

  /** Transaction version of {@link SqlClient.exec}. */
  public async exec<TRow extends object = SqlRow, TOutput extends ExecOutput = ExecOutput>(
    procedure: string,
    params: SqlRow = {},
    options: ExecOptions<TOutput> = {},
  ): Promise<ExecResult<TRow, ExecOutputValues<TOutput>>> {
    return this.enqueue('exec', async () =>
      execCommand<TRow, TOutput>(this.context, procedure, params, options),
    );
  }

  /** Transaction version of {@link SqlClient.query}: tagged template, fragment or text. */
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
    return this.enqueue('query', async () => {
      const { text, params, options } = normalizeQuery(input, rest);

      return queryCommand<TRow>(this.context, text, params, options);
    });
  }

  /** Transaction version of {@link SqlClient.queryFile}. */
  public async queryFile<TRow extends object = SqlRow>(
    file: string,
    params: SqlParams = {},
    options: RawQueryOptions = {},
  ): Promise<QueryResult<TRow>> {
    return this.enqueue('queryFile', async () =>
      queryFileCommand<TRow>(this.context, file, params, options),
    );
  }

  /** Transaction version of {@link SqlClient.set}. */
  public set<TRow extends object = SqlRow>(table: string, options: SqlSetOptions): SqlSet<TRow> {
    return new SqlSet<TRow>(table, options, async (work, queryOptions) =>
      this.enqueue('set', async () => work(this.context, queryOptions)),
    );
  }

  /**
   * Waits for every queued operation to settle.
   *
   * @internal
   */
  public async settle(): Promise<void> {
    await this.queue;
  }

  /**
   * Marks the transaction as committed or rolled back; later calls throw.
   *
   * @internal
   */
  public finish(): void {
    this.finished = true;
  }

  private assertActive(): void {
    if (this.finished) {
      throw new SqlClientError(
        'The transaction has already finished. Did you forget to await an operation inside it?',
      );
    }
  }

  private async enqueue<TResult>(
    name: SqlOperation,
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    try {
      this.assertActive();
    } catch (error) {
      throw normalizeError(error, name);
    }

    const previous = this.queue;
    const run = (async () => {
      await previous;

      try {
        return await operation();
      } catch (error) {
        throw normalizeError(error, name);
      }
    })();

    // The queue never rejects, so one failed operation doesn't block the next; the caller still
    // receives the rejection through `run`.
    this.queue = (async () => {
      try {
        await run;
      } catch {
        // Reported to the caller.
      }
    })();

    return run;
  }

  /**
   * Batches inside a transaction use savepoints: `'rollback'` mode undoes only its own rows, and
   * `'continue'` mode isolates each row without touching the caller's work.
   */
  private connection(): BatchConnection {
    return {
      nested: true,
      request: () => this.transaction.request(),
      begin: async () => {
        const savepoint = `_batch${++this.savepoints}`;

        await this.transaction.request().batch(`SAVE TRAN ${savepoint};`);

        return {
          request: () => this.transaction.request(),
          commit: async () => Promise.resolve(),
          rollback: async () => {
            await this.transaction
              .request()
              .batch(`IF XACT_STATE() = 1 ROLLBACK TRAN ${savepoint};`);
          },
        };
      },
    };
  }
}
