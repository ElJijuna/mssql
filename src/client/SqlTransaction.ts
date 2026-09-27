import type sql from 'mssql';
import type { QueryOptions, QueryRunner } from '../debug/debug';
import { SqlClientError } from '../errors/SqlClientError';
import type { SqlOperation, SqlRowFailureEvent } from '../events/events';
import type { BatchConnection, BatchOptions } from './batch';
import {
  type CommandContext,
  deleteCommand,
  insertCommand,
  insertManyCommand,
  mergeCommand,
  updateCommand,
} from './commands';
import type { MergeOptions } from './merge';
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
}

/**
 * What {@link SqlTransaction} needs from its client.
 *
 * @internal
 */
export interface TransactionHooks {
  runner: (operation: SqlOperation, options: QueryOptions, transactionId: number) => QueryRunner;
  rowFailure: (event: SqlRowFailureEvent) => void;
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

  /** Transaction version of {@link SqlClient.insert}. */
  public async insert(
    table: string,
    row: SqlRow,
    options: QueryOptions = {},
  ): Promise<number | null> {
    return this.enqueue(async () => insertCommand(this.context, table, row, options));
  }

  /** Transaction version of {@link SqlClient.insertMany}. */
  public async insertMany(
    table: string,
    rows: SqlRow[],
    options: BatchOptions = {},
  ): Promise<InsertManyResult> {
    return this.enqueue(async () => insertManyCommand(this.context, table, rows, options));
  }

  /** Transaction version of {@link SqlClient.merge}. */
  public async merge(table: string, rows: SqlRow[], options: MergeOptions): Promise<MergeResult> {
    return this.enqueue(async () => mergeCommand(this.context, table, rows, options));
  }

  /** Transaction version of {@link SqlClient.update}. */
  public async update(
    table: string,
    values: SqlRow,
    where: SqlRow,
    options: QueryOptions = {},
  ): Promise<number> {
    return this.enqueue(async () => updateCommand(this.context, table, values, where, options));
  }

  /** Transaction version of {@link SqlClient.delete}. */
  public async delete(table: string, where: SqlRow, options: QueryOptions = {}): Promise<number> {
    return this.enqueue(async () => deleteCommand(this.context, table, where, options));
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

  private async enqueue<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    this.assertActive();

    const previous = this.queue;
    const run = (async () => {
      await previous;

      return operation();
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
