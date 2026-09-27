import { SqlAbortError } from '../errors/SqlAbortError';
import { SqlClientError } from '../errors/SqlClientError';
import { SqlConnectionError } from '../errors/SqlConnectionError';
import {
  errorNumber,
  isRetryable,
  resolveRetry,
  retryDelay,
  TRANSIENT_ERROR_NUMBERS,
} from './retry';

const policy = resolveRetry(undefined, undefined, true);

if (!policy) {
  throw new Error('default policy expected');
}

const sqlError = (number: number) =>
  Object.assign(new Error(`error ${String(number)}`), { number });

describe('resolveRetry', () => {
  it('is on by default for safe helpers with 3 attempts', () => {
    expect(policy).toMatchObject({ attempts: 3, delay: 100, maxDelay: 2_000 });
    expect([...policy.errorNumbers]).toEqual(TRANSIENT_ERROR_NUMBERS);
  });

  it('is off by default for calls that must opt in', () => {
    expect(resolveRetry(undefined, undefined, false)).toBeNull();
    expect(resolveRetry({ attempts: 5 }, undefined, false)).toBeNull();
    expect(resolveRetry({ attempts: 5 }, true, false)).toMatchObject({ attempts: 5 });
  });

  it('lets the call override the client', () => {
    expect(resolveRetry(false, undefined, true)).toBeNull();
    expect(resolveRetry(true, false, true)).toBeNull();
    expect(resolveRetry(false, true, true)).toMatchObject({ attempts: 3 });
    expect(resolveRetry({ attempts: 5, delay: 10 }, { delay: 50 }, true)).toMatchObject({
      attempts: 5,
      delay: 50,
    });
  });

  it('treats zero attempts as disabled and validates numbers', () => {
    expect(resolveRetry({ attempts: 0 }, undefined, true)).toBeNull();
    expect(() => resolveRetry({ attempts: 1.5 }, undefined, true)).toThrow(SqlClientError);
    expect(() => resolveRetry({ delay: -1 }, undefined, true)).toThrow(SqlClientError);
  });
});

describe('errorNumber', () => {
  it('reads the number from the error, its info, originalError or cause', () => {
    expect(errorNumber(sqlError(1205))).toBe(1205);
    expect(errorNumber({ info: { number: 40613 } })).toBe(40613);
    expect(errorNumber({ originalError: { info: { number: 40501 } } })).toBe(40501);
    expect(errorNumber(new SqlClientError('wrapped', { cause: sqlError(40197) }))).toBe(40197);
    expect(errorNumber(new Error('plain'))).toBeNull();
    expect(errorNumber(undefined)).toBeNull();
  });
});

describe('isRetryable', () => {
  it('retries transient numbers and connection failures only', () => {
    expect(isRetryable(sqlError(1205), 1, policy)).toBe(true);
    expect(isRetryable(sqlError(2627), 1, policy)).toBe(false);
    expect(isRetryable(new SqlConnectionError('down'), 1, policy)).toBe(true);
  });

  it('never retries cancellations', () => {
    expect(
      isRetryable(new SqlAbortError('select', 'timeout', { cause: sqlError(1205) }), 1, policy),
    ).toBe(false);
  });

  it('only retries connection failures in connection-only mode', () => {
    expect(isRetryable(sqlError(1205), 1, policy, true)).toBe(false);
    expect(isRetryable(new SqlConnectionError('down'), 1, policy, true)).toBe(true);
  });

  it('uses shouldRetry instead of the numbers when given', () => {
    const custom = resolveRetry(
      { shouldRetry: (error) => (error as Error).message === 'flaky' },
      undefined,
      true,
    );

    expect(custom && isRetryable(new Error('flaky'), 1, custom)).toBe(true);
    expect(custom && isRetryable(sqlError(1205), 1, custom)).toBe(false);
  });
});

describe('retryDelay', () => {
  it('grows exponentially with jitter and is capped', () => {
    for (let i = 0; i < 50; i++) {
      expect(retryDelay(1, policy)).toBeGreaterThanOrEqual(50);
      expect(retryDelay(1, policy)).toBeLessThanOrEqual(100);
      expect(retryDelay(3, policy)).toBeGreaterThanOrEqual(200);
      expect(retryDelay(3, policy)).toBeLessThanOrEqual(400);
      expect(retryDelay(10, policy)).toBeLessThanOrEqual(2_000);
    }
  });
});
