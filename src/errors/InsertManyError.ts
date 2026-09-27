import type { SqlRow } from '../client/SqlClient';
import { SqlClientError } from './SqlClientError';

/**
 * Thrown by {@link SqlClient.insertMany} in `'rollback'` mode when a row fails.
 * No rows are persisted when this error is thrown.
 */
export class InsertManyError extends SqlClientError {
  /**
   * @param index - Position of the failing row in the input array.
   * @param row - The failing row.
   * @param number - SQL Server error number (e.g. 2627 for a unique key violation), or `null`.
   * @param sqlMessage - SQL Server error message.
   */
  public constructor(
    public readonly index: number,
    public readonly row: SqlRow,
    public readonly number: number | null,
    public readonly sqlMessage: string,
  ) {
    super(`Row ${index} failed: ${sqlMessage}`);
    this.name = 'InsertManyError';
  }
}
