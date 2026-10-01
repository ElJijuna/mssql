import type { RowFailure } from '../client/batch';
import type { SqlDebugParam } from '../debug/debug';

/**
 * Helper that produced a query.
 */
export type SqlOperation =
  | 'page'
  | 'select'
  | 'findOne'
  | 'insert'
  | 'insertMany'
  | 'merge'
  | 'update'
  | 'delete'
  | 'exec'
  | 'query'
  | 'queryFile'
  | 'queryNamed'
  | 'set';

/**
 * A query about to be sent.
 */
export interface SqlQueryEvent {
  /** Correlates the `query`, `success` and `failure` events of the same execution. */
  id: number;
  /** Helper that produced the query. */
  operation: SqlOperation;
  /** Transaction the query ran in (see {@link SqlClient.transaction}), or `null`. */
  transactionId: number | null;
  /** SQL text exactly as sent, with `@p0`, `@p1`… placeholders. */
  sql: string;
  /** Bound parameters. */
  params: SqlDebugParam[];
}

/**
 * A query that completed.
 */
export interface SqlSuccessEvent extends SqlQueryEvent {
  /** Time from sending the query to receiving the result, in milliseconds. */
  durationMs: number;
  /** Rows affected by each statement, as reported by mssql. */
  rowsAffected: number[];
}

/**
 * A query that failed.
 */
export interface SqlFailureEvent extends SqlQueryEvent {
  /** Time from sending the query to receiving the error, in milliseconds. */
  durationMs: number;
  /** The error thrown by mssql. */
  error: unknown;
  /** SQL Server error number, or `null` when the error did not come from SQL Server. */
  number: number | null;
}

/**
 * A row that failed inside `insertMany` / `merge` (both `'rollback'` and `'continue'` modes).
 */
export interface SqlRowFailureEvent extends RowFailure {
  /** Helper that processed the row. */
  operation: SqlOperation;
}

/**
 * Connection pool became available to this client (opened or reused).
 */
export interface SqlConnectEvent {
  /** Time taken to make the pool available, in milliseconds. */
  durationMs: number;
}

/**
 * Connection pool failed to open.
 */
export interface SqlConnectFailureEvent extends SqlConnectEvent {
  /** The error thrown by mssql. */
  error: unknown;
}

/**
 * A transaction started.
 */
export interface SqlTransactionEvent {
  /** Correlates the transaction events with the `transactionId` of its queries. */
  transactionId: number;
}

/**
 * A transaction committed.
 */
export interface SqlTransactionCommitEvent extends SqlTransactionEvent {
  /** Time from `BEGIN` to `COMMIT`, in milliseconds. */
  durationMs: number;
}

/**
 * A transaction rolled back.
 */
export interface SqlTransactionRollbackEvent extends SqlTransactionCommitEvent {
  /** The error that caused the rollback. */
  error: unknown;
}

/**
 * A call (or some rows of a batch) is about to be retried after a transient error.
 */
export interface SqlRetryEvent {
  /** Helper being retried, or `transaction`. */
  operation: SqlOperation | 'transaction';
  /** The attempt that just failed (1 = the first try). */
  attempt: number;
  /** Wait before the next attempt, in milliseconds. */
  delayMs: number;
  /** The error (for row retries, the first failed row). */
  error: unknown;
  /** SQL Server error number, or `null` (e.g. connection failures). */
  number: number | null;
  /** For `'continue'` batches: the input indexes of the rows being retried. */
  rows?: number[];
}

/**
 * Events emitted by {@link SqlClient}. Subscribe with `client.on(event, listener)`.
 */
export interface SqlClientEvents {
  /** The pool became available to this client. */
  connect: SqlConnectEvent;
  /** The pool failed to connect. */
  connectFailure: SqlConnectFailureEvent;
  /** The client released the pool; the underlying pool was closed only if owned. */
  close: Record<string, never>;
  /** A query is about to be sent. */
  query: SqlQueryEvent;
  /** A query completed. For batches, rows may still have failed: see `rowFailure`. */
  success: SqlSuccessEvent;
  /** A query failed. */
  failure: SqlFailureEvent;
  /** A row of `insertMany` / `merge` failed. */
  rowFailure: SqlRowFailureEvent;
  /** A transaction started. */
  transactionBegin: SqlTransactionEvent;
  /** A transaction committed. */
  transactionCommit: SqlTransactionCommitEvent;
  /** A transaction rolled back. */
  transactionRollback: SqlTransactionRollbackEvent;
  /** A transient error is about to be retried. */
  retry: SqlRetryEvent;
}
