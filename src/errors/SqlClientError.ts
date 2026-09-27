/**
 * Base error thrown by @pilmee/mssql.
 */
export class SqlClientError extends Error {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SqlClientError';
  }
}
