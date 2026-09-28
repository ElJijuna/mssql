import type sql from 'mssql';
import type { RowAction, RowFailure } from './batch';

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
