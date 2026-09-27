import type sql from 'mssql';
import { quoteIdentifier } from '../utils/quoteIdentifier';
import { type BatchOptions, type RowStatementBuilder, track } from './batch';
import type { SqlRow } from './SqlClient';
import { bindRow, insertSql, keyPredicate } from './statements';

/**
 * Options for {@link SqlClient.merge}.
 */
export interface MergeOptions extends BatchOptions {
  /**
   * Column(s) that identify a row, e.g. `'email'` or `['tenantId', 'code']`.
   * Every row must include them.
   */
  on: string | string[];
  /**
   * Columns to update when the row already exists. Defaults to every non-key column in the row.
   * Pass `false` to only insert missing rows and leave existing ones untouched.
   */
  update?: string[] | false;
}

/**
 * @internal
 */
export const normalizeKeys = (on: string | string[]): string[] => (Array.isArray(on) ? on : [on]);

/**
 * Builds the per-row upsert: lock the key range, then UPDATE if the row exists or INSERT if not.
 * `UPDLOCK, SERIALIZABLE` prevents two concurrent merges from inserting the same key.
 *
 * @internal
 */
export const buildMergeStatement =
  (table: string, keys: string[], update: string[] | false | undefined): RowStatementBuilder =>
  (row: SqlRow, request: sql.Request, offset: number): string => {
    const target = quoteIdentifier(table);
    const params = bindRow(row, request, offset);
    const where = keyPredicate(keys, row, params);
    const columns = update === false ? [] : (update ?? Object.keys(row));
    const assignments = columns
      .filter((column) => !keys.includes(column) && params.has(column))
      .map((column) => `${quoteIdentifier(column)} = ${params.get(column) ?? 'NULL'}`);
    const whenExists =
      assignments.length === 0
        ? track('skipped')
        : `UPDATE ${target} SET ${assignments.join(', ')} WHERE ${where}; ${track('updated')}`;

    return [
      `IF EXISTS (SELECT 1 FROM ${target} WITH (UPDLOCK, SERIALIZABLE) WHERE ${where})`,
      `BEGIN ${whenExists} END`,
      `ELSE BEGIN ${insertSql(target, params)} ${track('inserted', 'SCOPE_IDENTITY()')} END;`,
    ].join(' ');
  };

/**
 * Returns an error message when a row lacks a key column.
 *
 * @internal
 */
export const missingKey =
  (keys: string[]) =>
  (row: SqlRow): string | null => {
    const missing = keys.filter((key) => !(key in row));

    return missing.length === 0 ? null : `Missing key column(s): ${missing.join(', ')}`;
  };
