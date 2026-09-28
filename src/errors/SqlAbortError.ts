import { SqlClientError } from './SqlClientError';

/**
 * Thrown when a call is cancelled through its `signal` or exceeds its `timeout`. The running query
 * is cancelled on the server.
 */
export class SqlAbortError extends SqlClientError {
  /**
   * @param operation - Helper that was cancelled (e.g. `select`).
   * @param reason - `'abort'` when the signal fired, `'timeout'` when the time limit passed.
   * @param options - `cause` is the signal's reason (for `'abort'`).
   */
  public constructor(
    public readonly operation: string,
    public readonly reason: 'abort' | 'timeout',
    options?: { cause?: unknown; timeout?: number },
  ) {
    super(
      reason === 'timeout'
        ? `${operation} timed out after ${String(options?.timeout)} ms`
        : `${operation} was aborted`,
      { cause: options?.cause },
    );
    this.name = 'SqlAbortError';
  }
}
