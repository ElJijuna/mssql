import type sql from 'mssql';
import { SqlAbortError } from '../errors/SqlAbortError';
import { SqlClientError } from '../errors/SqlClientError';
import { createCallGuard, createScope, pause } from './cancellation';

const fakeRequest = () => {
  const cancel = jest.fn();

  return { cancel, request: { cancel } as unknown as sql.Request };
};
/** A running query that, like mssql, rejects once `request.cancel()` is called. */
const cancellable = () => {
  let rejectQuery: (error: Error) => void = () => undefined;

  const query = new Promise<never>((_resolve, reject) => {
    rejectQuery = reject;
  });
  const cancel = jest.fn(() => {
    rejectQuery(new Error('Canceled.'));
  });

  return { query, cancel, request: { cancel } as unknown as sql.Request };
};
const sleep = async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const captureError = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('Expected promise to reject');
};

describe('createCallGuard', () => {
  it('passes the query through when there are no limits', async () => {
    const { request, cancel } = fakeRequest();

    await expect(createCallGuard('select', {}).run(request, Promise.resolve(1))).resolves.toBe(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('throws right away when the signal is already aborted', () => {
    const reason = new Error('user left');

    expect(() => createCallGuard('select', { signal: AbortSignal.abort(reason) })).toThrow(
      expect.objectContaining({ name: 'SqlAbortError', reason: 'abort', cause: reason }) as Error,
    );
  });

  it('cancels the running query when the signal aborts', async () => {
    const { request, cancel, query } = cancellable();
    const controller = new AbortController();
    const running = createCallGuard('select', { signal: controller.signal }).run(request, query);

    controller.abort();
    const error = await captureError(running);

    expect(error).toBeInstanceOf(SqlAbortError);
    expect(error).toMatchObject({
      operation: 'select',
      reason: 'abort',
      message: 'select was aborted',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels the running query when the timeout passes', async () => {
    const { request, cancel, query } = cancellable();
    const error = await captureError(createCallGuard('merge', { timeout: 20 }).run(request, query));

    expect(error).toMatchObject({ reason: 'timeout', message: 'merge timed out after 20 ms' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('shares one deadline across every query of the call', async () => {
    const guard = createCallGuard('insertMany', { timeout: 30 });

    await guard.run(fakeRequest().request, sleep(20));

    const second = cancellable();

    await expect(guard.run(second.request, second.query)).rejects.toMatchObject({
      reason: 'timeout',
    });
  });

  it('waits for the driver to confirm the cancel before rejecting', async () => {
    let finishQuery: (error: Error) => void = () => undefined;

    const query = new Promise<never>((_resolve, reject) => {
      finishQuery = reject;
    });
    const events: string[] = [];
    const running = createCallGuard('select', { timeout: 10 }).run(fakeRequest().request, query);

    void (async () => {
      try {
        await running;
      } catch {
        events.push('rejected');
      }
    })();

    await sleep(40);
    events.push('driver confirms');
    finishQuery(new Error('Canceled.'));
    await expect(running).rejects.toMatchObject({ reason: 'timeout' });

    expect(events).toEqual(['driver confirms', 'rejected']);
  });

  it('keeps the result of a query that finished despite the cancel', async () => {
    const controller = new AbortController();
    const finished = (async () => {
      await sleep(20);

      return 'done';
    })();
    const running = createCallGuard('select', { signal: controller.signal }).run(
      fakeRequest().request,
      finished,
    );

    controller.abort();

    await expect(running).resolves.toBe('done');
  });

  it('cancels only once when several limits fire', async () => {
    let finishQuery: (error: Error) => void = () => undefined;

    const query = new Promise<never>((_resolve, reject) => {
      finishQuery = reject;
    });
    const { request, cancel } = fakeRequest();
    const controller = new AbortController();
    const running = createCallGuard('select', { signal: controller.signal, timeout: 5 }).run(
      request,
      query,
    );

    await sleep(20);
    controller.abort();
    finishQuery(new Error('Canceled.'));

    await expect(running).rejects.toMatchObject({ reason: 'timeout' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('removes its listeners when the query settles', async () => {
    const controller = new AbortController();
    const remove = jest.spyOn(controller.signal, 'removeEventListener');

    await createCallGuard('select', { signal: controller.signal, timeout: 1000 }).run(
      fakeRequest().request,
      Promise.resolve('ok'),
    );

    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('keeps the query error when nothing was cancelled', async () => {
    const failure = new Error('Invalid object name');

    await expect(
      createCallGuard('select', { timeout: 1000 }).run(
        fakeRequest().request,
        Promise.reject(failure),
      ),
    ).rejects.toBe(failure);
  });

  it('reports the scope when its limit is hit first', async () => {
    const { request, query } = cancellable();
    const scope = createScope('transaction', { timeout: 10 });
    const error = await captureError(
      createCallGuard('update', { timeout: 1000 }, scope).run(request, query),
    );

    expect(error).toMatchObject({ operation: 'transaction', reason: 'timeout' });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid timeout %p', (timeout) => {
    expect(() => createCallGuard('select', { timeout })).toThrow(SqlClientError);
    expect(() => createScope('transaction', { timeout })).toThrow(SqlClientError);
  });
});

import { getEventListeners } from 'node:events';

describe('deterministic cancellation and retry waits', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('checks the scope signal and preserves its abort cause before starting', () => {
    const reason = new Error('transaction cancelled');
    const scope = createScope('transaction', { signal: AbortSignal.abort(reason) });

    expect(() => createCallGuard('query', {}, scope)).toThrow(
      expect.objectContaining({
        operation: 'transaction',
        reason: 'abort',
        cause: reason,
      }) as Error,
    );
    expect(jest.getTimerCount()).toBe(0);
  });

  it('checks elapsed deadlines before another query starts', async () => {
    const guard = createCallGuard('query', { timeout: 10 });

    await jest.advanceTimersByTimeAsync(10);

    expect(() => guard.check()).toThrow(
      expect.objectContaining({ reason: 'timeout', operation: 'query' }) as Error,
    );
    expect(() => createCallGuard('query', { timeout: 0 })).toThrow(SqlAbortError);
    expect(() => createCallGuard('query', {}, createScope('transaction', { timeout: 0 }))).toThrow(
      SqlAbortError,
    );
  });

  it('uses the shorter local deadline inside a longer transaction scope', async () => {
    const { request, query, cancel } = cancellable();
    const running = createCallGuard(
      'query',
      { timeout: 10 },
      createScope('transaction', { timeout: 100 }),
    ).run(request, query);
    const error = captureError(running);

    await jest.advanceTimersByTimeAsync(10);

    await expect(error).resolves.toMatchObject({ reason: 'timeout', operation: 'query' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not cancel twice when a previously queued abort handler runs after cleanup', async () => {
    const controller = new AbortController();
    const add = jest.spyOn(controller.signal, 'addEventListener');
    const { request, query, cancel } = cancellable();
    const running = createCallGuard(
      'query',
      { signal: controller.signal },
      createScope('transaction', { signal: controller.signal }),
    ).run(request, query);
    const captured = captureError(running);
    const queued = add.mock.calls[1]?.[1] as (event: Event) => void;

    controller.abort('cancel once');
    queued(new Event('abort'));

    await expect(captured).resolves.toMatchObject({ cause: 'cancel once' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('wraps non-Error query rejection and cleans timers/listeners', async () => {
    const controller = new AbortController();
    const query = jest.fn<Promise<never>, []>().mockRejectedValue('driver rejected');

    await expect(
      createCallGuard('query', { signal: controller.signal, timeout: 100 }).run(
        fakeRequest().request,
        query(),
      ),
    ).rejects.toMatchObject({ name: 'SqlClientError', message: 'driver rejected' });
    expect(jest.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('removes successful query limits so a later abort cannot cancel the request', async () => {
    const controller = new AbortController();
    const { request, cancel } = fakeRequest();

    await expect(
      createCallGuard('query', { signal: controller.signal, timeout: 100 }).run(
        request,
        Promise.resolve('ok'),
      ),
    ).resolves.toBe('ok');
    controller.abort();
    await jest.advanceTimersByTimeAsync(100);

    expect(cancel).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('creates a scope without a deadline when no timeout was configured', () => {
    expect(createScope('transaction', {})).toEqual({
      name: 'transaction',
      signal: undefined,
      timeout: undefined,
      deadline: undefined,
    });
    expect(createScope('transaction', { timeout: 25 }).deadline).toBe(performance.now() + 25);
  });

  it('waits normally without a scope and clears its timer', async () => {
    let completed = false;

    const waiting = (async () => {
      await pause(20);
      completed = true;
    })();

    await jest.advanceTimersByTimeAsync(19);
    expect(completed).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await waiting;
    expect(completed).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects an already aborted retry scope without creating a timer', async () => {
    const reason = new Error('stop retries');

    await expect(
      pause(20, createScope('query', { signal: AbortSignal.abort(reason) })),
    ).rejects.toMatchObject({ operation: 'query', cause: reason, reason: 'abort' });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('interrupts a retry wait immediately on abort and removes its listener', async () => {
    const controller = new AbortController();
    const error = captureError(pause(100, createScope('query', { signal: controller.signal })));

    await jest.advanceTimersByTimeAsync(10);
    controller.abort('client left');

    await expect(error).resolves.toMatchObject({
      operation: 'query',
      cause: 'client left',
      reason: 'abort',
    });
    expect(jest.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('limits retry waits to the remaining timeout and clears abort listeners', async () => {
    const controller = new AbortController();
    const scope = createScope('transaction', { signal: controller.signal, timeout: 30 });

    await jest.advanceTimersByTimeAsync(20);
    const error = captureError(pause(100, scope));

    await jest.advanceTimersByTimeAsync(10);

    await expect(error).resolves.toMatchObject({
      operation: 'transaction',
      reason: 'timeout',
      message: 'transaction timed out after 30 ms',
    });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('cleans a normal scoped wait before a later abort or deadline', async () => {
    const controller = new AbortController();
    const waiting = pause(
      10,
      createScope('transaction', { signal: controller.signal, timeout: 30 }),
    );

    await jest.advanceTimersByTimeAsync(10);
    await expect(waiting).resolves.toBeUndefined();
    controller.abort();
    await jest.advanceTimersByTimeAsync(30);

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects an already expired retry deadline at the next timer turn', async () => {
    const scope = createScope('query', { timeout: 10 });

    await jest.advanceTimersByTimeAsync(20);
    const error = captureError(pause(100, scope));

    await jest.advanceTimersByTimeAsync(0);

    await expect(error).resolves.toMatchObject({ reason: 'timeout' });
    expect(jest.getTimerCount()).toBe(0);
  });
});
