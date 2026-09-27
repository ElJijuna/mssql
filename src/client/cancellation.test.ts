import type sql from 'mssql';
import { SqlAbortError } from '../errors/SqlAbortError';
import { SqlClientError } from '../errors/SqlClientError';
import { createCallGuard, createScope } from './cancellation';

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
