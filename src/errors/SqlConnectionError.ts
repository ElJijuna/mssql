import { SqlClientError } from './SqlClientError';

/**
 * Thrown when the connection pool can't connect to SQL Server. Nothing was executed, so calls that
 * fail with it are always safe to retry. The driver's error is in `cause`.
 */
export class SqlConnectionError extends SqlClientError {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SqlConnectionError';
  }
}
