import { BatchRowError } from './BatchRowError';
import { SqlAbortError } from './SqlAbortError';
import { errorMetadata, SqlClientError } from './SqlClientError';
import { SqlConnectionError } from './SqlConnectionError';
import { normalizeError, SqlQueryError } from './SqlQueryError';

describe('error contract', () => {
  it('preserves driver metadata and the original cause', () => {
    const cause = Object.assign(new Error('duplicate'), {
      code: 'EREQUEST',
      originalError: { info: { number: 2627 } },
    });
    const error = normalizeError(cause, 'insert');

    expect(error).toBeInstanceOf(SqlClientError);
    expect(error).toBeInstanceOf(SqlQueryError);
    expect(error).toMatchObject({
      code: 'SQL_QUERY_ERROR',
      driverCode: 'EREQUEST',
      number: 2627,
      operation: 'insert',
      cause,
    });
    expect(normalizeError(error, 'transaction')).toBe(error);
    expect(error.operation).toBe('insert');
  });

  it('checks both nested branches and terminates on cyclic causes', () => {
    const error: { originalError: unknown; cause?: unknown } = { originalError: {} };

    error.cause = { number: 1205, cause: error };

    expect(errorMetadata(error)).toEqual({ number: 1205, driverCode: null });
  });

  it('handles non-Error thrown values', () => {
    expect(normalizeError(null, 'query')).toMatchObject({
      message: 'null',
      code: 'SQL_QUERY_ERROR',
      number: null,
      driverCode: null,
      cause: null,
    });
  });

  it('exposes distinct codes for connection, timeout, cancellation, and batch failures', () => {
    expect(new SqlConnectionError('offline')).toMatchObject({
      code: 'SQL_CONNECTION_ERROR',
      operation: 'connect',
    });
    expect(new SqlAbortError('query', 'timeout', { timeout: 5 }).code).toBe('SQL_TIMEOUT_ERROR');
    expect(new SqlAbortError('query', 'abort').code).toBe('SQL_ABORT_ERROR');
    expect(new BatchRowError(0, {}, 2627, 'duplicate')).toMatchObject({
      code: 'SQL_BATCH_ROW_ERROR',
      number: 2627,
    });
  });
});
