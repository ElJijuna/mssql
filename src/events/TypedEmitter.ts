/**
 * Listener for an event payload.
 */
export type Listener<TPayload> = (payload: TPayload) => void;

/**
 * Options for {@link TypedEmitter.on} and {@link TypedEmitter.once}.
 */
export interface SubscribeOptions {
  /**
   * Removes the listener when aborted. If already aborted, the listener is never added.
   *
   * @example
   * const controller = new AbortController();
   * client.on('failure', report, { signal: controller.signal });
   * controller.abort(); // unsubscribes
   */
  signal?: AbortSignal;
}

/**
 * Minimal typed event emitter. Listener errors are caught and reported with `console.error`, so a
 * faulty listener never breaks the operation that emitted the event.
 */
export class TypedEmitter<TEvents extends object> {
  private readonly listeners = new Map<keyof TEvents, Set<Listener<never>>>();

  /**
   * Subscribes to an event.
   */
  public on<TEvent extends keyof TEvents>(
    event: TEvent,
    listener: Listener<TEvents[TEvent]>,
    options: SubscribeOptions = {},
  ): this {
    if (options.signal?.aborted) {
      return this;
    }

    const set = this.listeners.get(event) ?? new Set();

    set.add(listener);
    this.listeners.set(event, set);
    options.signal?.addEventListener('abort', () => this.off(event, listener), { once: true });

    return this;
  }

  /**
   * Subscribes to the next occurrence of an event only.
   */
  public once<TEvent extends keyof TEvents>(
    event: TEvent,
    listener: Listener<TEvents[TEvent]>,
    options: SubscribeOptions = {},
  ): this {
    const wrapper: Listener<TEvents[TEvent]> = (payload) => {
      this.off(event, wrapper);
      listener(payload);
    };

    return this.on(event, wrapper, options);
  }

  /**
   * Unsubscribes a listener. Without a listener, removes every listener of the event.
   */
  public off<TEvent extends keyof TEvents>(
    event: TEvent,
    listener?: Listener<TEvents[TEvent]>,
  ): this {
    if (listener) {
      this.listeners.get(event)?.delete(listener);
    } else {
      this.listeners.delete(event);
    }

    return this;
  }

  /**
   * Whether the event has at least one listener.
   */
  protected hasListeners(event: keyof TEvents): boolean {
    return (this.listeners.get(event)?.size ?? 0) > 0;
  }

  /**
   * Calls every listener of the event with `payload`.
   */
  protected emit<TEvent extends keyof TEvents>(event: TEvent, payload: TEvents[TEvent]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      try {
        (listener as Listener<TEvents[TEvent]>)(payload);
      } catch (error) {
        console.error(`[@pilmee/mssql] listener for "${String(event)}" threw`, error);
      }
    }
  }
}
