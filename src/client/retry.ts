import { SqlAbortError } from '../errors/SqlAbortError';
import { SqlClientError } from '../errors/SqlClientError';
import { SqlConnectionError } from '../errors/SqlConnectionError';

/**
 * SQL Server / Azure SQL error numbers that are safe to retry: the server rejected or rolled back
 * the work (deadlock victim, database failing over, service busy, resource limits, In-Memory OLTP
 * conflicts).
 */
export const TRANSIENT_ERROR_NUMBERS: readonly number[] = [
  1205, // deadlock victim
  4060, // cannot open database (Azure failover)
  4221, // login to read-secondary failed during transition
  10928, // resource limit reached
  10929, // resource limit reached
  40143, // service failed to process the request
  40197, // service error processing the request (e.g. reconfiguration)
  40501, // service is busy
  40540, // service error processing the request
  40613, // database not currently available
  41301, // In-Memory OLTP dependency failure
  41302, // In-Memory OLTP update conflict
  41305, // In-Memory OLTP repeatable read validation
  41325, // In-Memory OLTP serializable validation
  41839, // In-Memory OLTP too many dependencies
  49918, // not enough resources to process the request
  49919, // too many create/update operations in progress
  49920, // too many operations in progress
];

/**
 * How to retry transient errors.
 */
export interface RetryOptions {
  /** Retries after the first attempt. Defaults to `3`. `0` disables retrying. */
  attempts?: number;
  /** Base delay in ms, doubled on every retry (with jitter). Defaults to `100`. */
  delay?: number;
  /** Maximum delay between attempts in ms. Defaults to `2000`. */
  maxDelay?: number;
  /** Error numbers to retry. Defaults to {@link TRANSIENT_ERROR_NUMBERS}. */
  errorNumbers?: readonly number[];
  /**
   * Custom decision, replacing `errorNumbers`: return `true` to retry. Cancellations
   * ({@link SqlAbortError}) are never retried.
   */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

/**
 * `true` uses the default {@link RetryOptions}, `false` disables retrying.
 */
export type RetryOption = boolean | RetryOptions;

/**
 * @internal
 */
export interface RetryPolicy {
  attempts: number;
  delay: number;
  maxDelay: number;
  errorNumbers: ReadonlySet<number>;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

const assertNonNegative = (name: string, value: number | undefined, integer = false): void => {
  if (
    value !== undefined &&
    (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value)))
  ) {
    throw new SqlClientError(
      `\`retry.${name}\` must be a non-negative ${integer ? 'integer' : 'number'}`,
    );
  }
};
const toPolicy = (options: RetryOptions): RetryPolicy => {
  assertNonNegative('attempts', options.attempts, true);
  assertNonNegative('delay', options.delay);
  assertNonNegative('maxDelay', options.maxDelay);

  return {
    attempts: options.attempts ?? 3,
    delay: options.delay ?? 100,
    maxDelay: options.maxDelay ?? 2_000,
    errorNumbers: new Set(options.errorNumbers ?? TRANSIENT_ERROR_NUMBERS),
    shouldRetry: options.shouldRetry,
  };
};

/**
 * Combines the client-level and call-level options. `enabledByDefault` is `false` for calls whose
 * SQL may not be safe to repeat (`exec`, `query`, `queryFile`, `transaction`): they only retry when
 * the call opts in.
 *
 * @internal
 */
export const resolveRetry = (
  clientOption: RetryOption | undefined,
  callOption: RetryOption | undefined,
  enabledByDefault: boolean,
): RetryPolicy | null => {
  const client = typeof clientOption === 'object' ? clientOption : {};

  if (
    callOption === false ||
    (callOption === undefined && (!enabledByDefault || clientOption === false))
  ) {
    return null;
  }

  const policy = toPolicy(typeof callOption === 'object' ? { ...client, ...callOption } : client);

  return policy.attempts === 0 ? null : policy;
};

/**
 * The SQL Server error number of an error, looking through `originalError` and `cause`.
 *
 * @internal
 */
export const errorNumber = (error: unknown): number | null => {
  let current: unknown = error;

  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    const candidate = current as {
      number?: unknown;
      info?: { number?: unknown };
      originalError?: unknown;
      cause?: unknown;
    };

    if (typeof candidate.number === 'number') {
      return candidate.number;
    }

    if (typeof candidate.info?.number === 'number') {
      return candidate.info.number;
    }

    current = candidate.originalError ?? candidate.cause;
  }

  return null;
};

/**
 * Whether `error` should be retried. With `connectionOnly`, only connection failures qualify (for
 * calls that may have already saved part of their work).
 *
 * @internal
 */
export const isRetryable = (
  error: unknown,
  attempt: number,
  policy: RetryPolicy,
  connectionOnly = false,
): boolean => {
  if (error instanceof SqlAbortError) {
    return false;
  }

  if (error instanceof SqlConnectionError) {
    return true;
  }

  if (connectionOnly) {
    return false;
  }

  if (policy.shouldRetry) {
    return policy.shouldRetry(error, attempt);
  }

  const number = errorNumber(error);

  return number !== null && policy.errorNumbers.has(number);
};

/**
 * Delay before retry number `attempt` (1-based): exponential, capped, with jitter so concurrent
 * clients don't retry in lockstep.
 *
 * @internal
 */
export const retryDelay = (attempt: number, policy: RetryPolicy): number => {
  const ceiling = Math.min(policy.maxDelay, policy.delay * 2 ** (attempt - 1));

  return Math.round(ceiling / 2 + (Math.random() * ceiling) / 2);
};
