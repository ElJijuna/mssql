import { TypedEmitter } from './TypedEmitter';

interface Events {
  ping: { n: number };
  pong: string;
}

class Emitter extends TypedEmitter<Events> {
  public fire<TEvent extends keyof Events>(event: TEvent, payload: Events[TEvent]): void {
    this.emit(event, payload);
  }

  public has(event: keyof Events): boolean {
    return this.hasListeners(event);
  }
}

describe('TypedEmitter', () => {
  it('calls every listener of the event with the payload', () => {
    const emitter = new Emitter();
    const first = jest.fn();
    const second = jest.fn();
    const other = jest.fn();

    emitter.on('ping', first).on('ping', second).on('pong', other);
    emitter.fire('ping', { n: 1 });

    expect(first).toHaveBeenCalledWith({ n: 1 });
    expect(second).toHaveBeenCalledWith({ n: 1 });
    expect(other).not.toHaveBeenCalled();
  });

  it('calls once listeners a single time', () => {
    const emitter = new Emitter();
    const listener = jest.fn();

    emitter.once('ping', listener);
    emitter.fire('ping', { n: 1 });
    emitter.fire('ping', { n: 2 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(emitter.has('ping')).toBe(false);
  });

  it('removes one listener or all of an event', () => {
    const emitter = new Emitter();
    const first = jest.fn();
    const second = jest.fn();

    emitter.on('ping', first).on('ping', second).off('ping', first);
    emitter.fire('ping', { n: 1 });
    emitter.off('ping');
    emitter.fire('ping', { n: 2 });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes when the AbortSignal aborts', () => {
    const emitter = new Emitter();
    const listener = jest.fn();
    const controller = new AbortController();

    emitter.on('ping', listener, { signal: controller.signal });
    controller.abort();
    emitter.fire('ping', { n: 1 });

    expect(listener).not.toHaveBeenCalled();
  });

  it('never adds a listener with an already aborted signal', () => {
    const emitter = new Emitter();

    emitter.once('ping', jest.fn(), { signal: AbortSignal.abort() });

    expect(emitter.has('ping')).toBe(false);
  });

  it('isolates listener errors so emit never throws', () => {
    const emitter = new Emitter();
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const after = jest.fn();

    emitter
      .on('pong', () => {
        throw new Error('listener bug');
      })
      .on('pong', after);

    expect(() => emitter.fire('pong', 'x')).not.toThrow();
    expect(after).toHaveBeenCalledWith('x');
    expect(error).toHaveBeenCalledWith(
      '[@pilmee/mssql] listener for "pong" threw',
      expect.any(Error),
    );
    error.mockRestore();
  });
});
