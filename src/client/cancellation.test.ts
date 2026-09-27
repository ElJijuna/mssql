import type sql from 'mssql';
import { SqlAbortError } from '../errors/SqlAbortError';
import { SqlClientError } from '../errors/SqlClientError';
import { createCallGuard, createScope } from './cancellation';

const fakeRequest = () => {
  const cancel = jest.fn();

  return { cancel, request: { cancel } as unknown as sql.Request };
};
const never = () => new Promise<never>(() => undefined);
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
    const { request, cancel } = fakeRequest();
    const controller = new AbortController();
    const running = createCallGuard('select', { signal: controller.signal }).run(request, never());

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
    const { request, cancel } = fakeRequest();
    const error = await captureError(
      createCallGuard('merge', { timeout: 20 }).run(request, never()),
    );

    expect(error).toMatchObject({ reason: 'timeout', message: 'merge timed out after 20 ms' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('shares one deadline across every query of the call', async () => {
    const { request } = fakeRequest();
    const guard = createCallGuard('insertMany', { timeout: 30 });

    await guard.run(request, sleep(20));

    await expect(guard.run(request, never())).rejects.toMatchObject({ reason: 'timeout' });
  });

  it('removes its listeners when the query settles', async () => {
    const { request } = fakeRequest();
    const controller = new AbortController();
    const remove = jest.spyOn(controller.signal, 'removeEventListener');

    await createCallGuard('select', { signal: controller.signal, timeout: 1000 }).run(
      request,
      Promise.resolve('ok'),
    );

    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('keeps the query error when nothing was cancelled', async () => {
    const { request } = fakeRequest();
    const failure = new Error('Invalid object name');

    await expect(
      createCallGuard('select', { timeout: 1000 }).run(request, Promise.reject(failure)),
    ).rejects.toBe(failure);
  });

  it('reports the scope when its limit is hit first', async () => {
    const { request } = fakeRequest();
    const scope = createScope('transaction', { timeout: 10 });
    const error = await captureError(
      createCallGuard('update', { timeout: 1000 }, scope).run(request, never()),
    );

    expect(error).toMatchObject({ operation: 'transaction', reason: 'timeout' });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid timeout %p', (timeout) => {
    expect(() => createCallGuard('select', { timeout })).toThrow(SqlClientError);
    expect(() => createScope('transaction', { timeout })).toThrow(SqlClientError);
  });
});
