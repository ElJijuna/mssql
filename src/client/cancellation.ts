import type sql from 'mssql';
import type { QueryOptions } from '../debug/debug';
import { SqlAbortError } from '../errors/SqlAbortError';
import { SqlClientError } from '../errors/SqlClientError';

/**
 * Enforces a call's `signal` and `timeout` across every query it sends.
 *
 * @internal
 */
export interface CallGuard {
  /** Throws if the call was aborted or ran out of time. */
  check: () => void;
  /**
   * Runs a query, cancelling it on the server if the call is aborted or times out meanwhile. After
   * cancelling, it waits for the driver to confirm before rejecting, so the connection is free again
   * (e.g. for a transaction rollback) by the time the caller sees the error.
   */
  run: <TResult>(request: sql.Request, query: Promise<TResult>) => Promise<TResult>;
}

/**
 * Limits inherited from an enclosing scope (a transaction's `signal` and `timeout`).
 *
 * @internal
 */
export interface CallScope {
  /** Name used in errors when the scope's limit is hit (e.g. `transaction`). */
  name: string;
  signal?: AbortSignal;
  timeout?: number;
  /** `performance.now()` value when the scope's timeout expires. */
  deadline?: number;
}

const assertTimeout = (timeout: number | undefined): void => {
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)) {
    throw new SqlClientError(
      `\`timeout\` must be a non-negative number of ms, got ${String(timeout)}`,
    );
  }
};

/**
 * Creates the limits of an enclosing scope, starting its clock now.
 *
 * @internal
 */
export const createScope = (
  name: string,
  options: { signal?: AbortSignal; timeout?: number },
): CallScope => {
  assertTimeout(options.timeout);

  return {
    name,
    signal: options.signal,
    timeout: options.timeout,
    deadline: options.timeout === undefined ? undefined : performance.now() + options.timeout,
  };
};

interface Limit {
  name: string;
  signal?: AbortSignal;
  timeout?: number;
  deadline?: number;
}

/**
 * Starts the clock for a call. Throws right away when a signal is already aborted or a deadline
 * has passed.
 *
 * @internal
 */
export const createCallGuard = (
  operation: string,
  options: QueryOptions,
  scope?: CallScope,
): CallGuard => {
  assertTimeout(options.timeout);

  const limits: Limit[] = [
    {
      name: operation,
      signal: options.signal,
      timeout: options.timeout,
      deadline: options.timeout === undefined ? undefined : performance.now() + options.timeout,
    },
    ...(scope ? [scope] : []),
  ].filter((limit) => limit.signal !== undefined || limit.deadline !== undefined);
  const aborted = (limit: Limit) =>
    new SqlAbortError(limit.name, 'abort', { cause: limit.signal?.reason });
  const timedOut = (limit: Limit) =>
    new SqlAbortError(limit.name, 'timeout', { timeout: limit.timeout });
  const check = (): void => {
    for (const limit of limits) {
      if (limit.signal?.aborted) {
        throw aborted(limit);
      }

      if (limit.deadline !== undefined && performance.now() >= limit.deadline) {
        throw timedOut(limit);
      }
    }
  };

  check();

  if (limits.length === 0) {
    return { check, run: async (_request, query) => query };
  }

  const run = async <TResult>(request: sql.Request, query: Promise<TResult>): Promise<TResult> =>
    new Promise<TResult>((resolve, reject) => {
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      const listeners: Array<[AbortSignal, () => void]> = [];
      const cleanup = () => {
        timers.forEach(clearTimeout);
        listeners.forEach(([signal, listener]) => {
          signal.removeEventListener('abort', listener);
        });
      };

      let cancelled: SqlAbortError | undefined;

      const cancel = (error: SqlAbortError) => {
        if (cancelled) {
          return;
        }

        cancelled = error;
        cleanup();
        request.cancel();
      };

      for (const limit of limits) {
        if (limit.signal) {
          const listener = () => {
            cancel(aborted(limit));
          };

          limit.signal.addEventListener('abort', listener, { once: true });
          listeners.push([limit.signal, listener]);
        }

        if (limit.deadline !== undefined) {
          const { deadline } = limit;

          timers.push(
            setTimeout(
              () => {
                cancel(timedOut(limit));
              },
              Math.max(0, deadline - performance.now()),
            ),
          );
        }
      }

      // Settles once the driver is done with the request. A query that still finished after the
      // cancel keeps its result (it was too late to stop); a cancelled one rejects with the reason.
      void (async () => {
        try {
          const result = await query;

          cleanup();
          resolve(result);
        } catch (error) {
          cleanup();
          reject(cancelled ?? (error instanceof Error ? error : new SqlClientError(String(error))));
        }
      })();
    });

  return { check, run };
};
