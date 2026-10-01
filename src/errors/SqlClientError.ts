/**
 * Stable machine-readable library error codes; driver codes are exposed separately.
 */
export type SqlErrorCode =
  | 'SQL_CLIENT_ERROR'
  | 'SQL_QUERY_ERROR'
  | 'SQL_CONNECTION_ERROR'
  | 'SQL_ABORT_ERROR'
  | 'SQL_TIMEOUT_ERROR'
  | 'SQL_BATCH_ROW_ERROR'
  | 'SQL_PRECISION_ERROR';

export interface SqlErrorOptions {
  cause?: unknown;
  code?: SqlErrorCode;
  operation?: string;
  number?: number | null;
}

/** Extract driver metadata from nested errors, with a bounded traversal. @internal */
export const errorMetadata = (
  error: unknown,
): { number: number | null; driverCode: string | null } => {
  let number: number | null = null;
  let driverCode: string | null = null;

  const pending: unknown[] = [error];
  const visited = new Set<unknown>();

  for (let index = 0; index < pending.length && index < 20; index++) {
    const current = pending[index];

    if (typeof current !== 'object' || current === null || visited.has(current)) {
      continue;
    }

    visited.add(current);
    const candidate = current as {
      number?: unknown;
      code?: unknown;
      driverCode?: unknown;
      info?: unknown;
      originalError?: unknown;
      cause?: unknown;
    };

    if (
      number === null &&
      typeof candidate.number === 'number' &&
      Number.isFinite(candidate.number)
    ) {
      ({ number } = candidate);
    }

    if (driverCode === null) {
      if (typeof candidate.driverCode === 'string') {
        ({ driverCode } = candidate);
      } else if (!(current instanceof SqlClientError) && typeof candidate.code === 'string') {
        driverCode = candidate.code;
      }
    }

    pending.push(candidate.info, candidate.originalError, candidate.cause);
  }

  return { number, driverCode };
};

/** Base error thrown by @pilmee/mssql. */
export class SqlClientError extends Error {
  public readonly code: SqlErrorCode;
  public readonly number: number | null;
  public readonly driverCode: string | null;
  public operation: string | null;

  public constructor(message: string, options: SqlErrorOptions = {}) {
    super(message, options);
    this.name = 'SqlClientError';
    const metadata = errorMetadata(options.cause);

    this.code = options.code ?? 'SQL_CLIENT_ERROR';
    this.number = options.number ?? metadata.number;
    this.driverCode = metadata.driverCode;
    this.operation = options.operation ?? null;
  }
}
