import { SqlClientError } from './SqlClientError';

/** A driver/query failure. The original thrown value is preserved in `cause`. */
export class SqlQueryError extends SqlClientError {
  public constructor(cause: unknown, operation: string) {
    super(cause instanceof Error ? cause.message : String(cause), {
      cause,
      operation,
      code: 'SQL_QUERY_ERROR',
    });
    this.name = 'SqlQueryError';
  }
}

/** Normalizes library failures without wrapping an existing library error again. @internal */
export const normalizeError = (error: unknown, operation: string): SqlClientError => {
  if (error instanceof SqlClientError) {
    error.operation ??= operation;

    return error;
  }

  return new SqlQueryError(error, operation);
};
