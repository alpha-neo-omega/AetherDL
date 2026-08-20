/**
 * Module: shared/utils (event system)
 * Purpose: Strongly-typed, leak-free event infrastructure (Phase 2 event system).
 *          Used by platform services to multiplex a single upstream browser listener
 *          to many application subscribers.
 * Responsibilities: subscribe/unsubscribe/once/emit/clear with full typing.
 * Restrictions: Leaf layer — no internal dependencies, no side effects at import
 *          (§8.16). Pure in-memory state owned by each instance.
 * Dependencies: none.
 * Public API: Unsubscribe, EventArgs, TypedEventEmitterOptions, TypedEventEmitter.
 */

/** Function returned by subscriptions to detach the listener. */
export type Unsubscribe = () => void;

/** An event map: event name → tuple of listener argument types. */
export type EventArgs = Record<string, readonly unknown[]>;

type AnyListener = (...args: readonly unknown[]) => void;

export interface TypedEventEmitterOptions {
  /**
   * Called when a listener throws. The emitter itself has no error taxonomy — it is a
   * leaf — so the owner decides where the failure goes. Omitted, the failure is
   * rethrown on a later microtask: visible to the context's error reporting, and
   * unable to interfere with the dispatch that is still in progress.
   */
  readonly onListenerError?: (error: unknown, event: string) => void;
}

/**
 * A typed event emitter. `M` maps event names to their argument tuples.
 *
 * Leak-free by contract: every `on`/`once` returns an {@link Unsubscribe}; `clear`
 * removes all listeners. Callers that attach an upstream source listener lazily
 * should detach it when {@link listenerCount} reaches zero.
 */
export class TypedEventEmitter<M extends EventArgs> {
  private readonly listeners = new Map<keyof M, Set<AnyListener>>();

  constructor(private readonly options: TypedEventEmitterOptions = {}) {}

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<K extends keyof M>(event: K, listener: (...args: M[K]) => void): Unsubscribe {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set<AnyListener>();
      this.listeners.set(event, set);
    }
    const wrapped = listener as AnyListener;
    set.add(wrapped);
    return () => {
      this.off(event, listener);
    };
  }

  /** Subscribe to the next emission only. Returns an unsubscribe function. */
  once<K extends keyof M>(event: K, listener: (...args: M[K]) => void): Unsubscribe {
    const off = this.on(event, ((...args: M[K]) => {
      off();
      listener(...args);
    }) as (...args: M[K]) => void);
    return off;
  }

  /** Remove a specific listener. */
  off<K extends keyof M>(event: K, listener: (...args: M[K]) => void): void {
    const set = this.listeners.get(event);
    if (set === undefined) {
      return;
    }
    set.delete(listener as AnyListener);
    if (set.size === 0) {
      this.listeners.delete(event);
    }
  }

  /**
   * Emit an event to all current listeners.
   *
   * Every listener is isolated. One subscriber that throws used to abort the dispatch
   * — every later listener was skipped — and the throw unwound into whatever emitted
   * the event, which in the download manager meant the scheduler's next step never
   * ran and the queue stalled. A subscriber's failure is its own (§20.7).
   */
  emit<K extends keyof M>(event: K, ...args: M[K]): void {
    const set = this.listeners.get(event);
    if (set === undefined) {
      return;
    }
    // Snapshot so listeners that unsubscribe during dispatch don't skip peers.
    for (const listener of [...set]) {
      try {
        (listener as (...a: M[K]) => void)(...args);
      } catch (error) {
        this.reportListenerError(error, String(event));
      }
    }
  }

  private reportListenerError(error: unknown, event: string): void {
    const handler = this.options.onListenerError;
    if (handler === undefined) {
      // Not swallowed: surfaced on a later microtask, where it cannot break dispatch.
      queueMicrotask(() => {
        throw error;
      });
      return;
    }
    try {
      handler(error, event);
    } catch {
      // A reporter that throws does not get to break dispatch either.
    }
  }

  /** Number of listeners for an event, or across all events when omitted. */
  listenerCount<K extends keyof M>(event?: K): number {
    if (event === undefined) {
      let total = 0;
      for (const set of this.listeners.values()) {
        total += set.size;
      }
      return total;
    }
    return this.listeners.get(event)?.size ?? 0;
  }

  /** Remove all listeners for an event, or all listeners when omitted. */
  clear<K extends keyof M>(event?: K): void {
    if (event === undefined) {
      this.listeners.clear();
      return;
    }
    this.listeners.delete(event);
  }
}

/**
 * Fans a single upstream source out to many subscribers. The `attach` callback is
 * invoked lazily when the first subscriber arrives and its returned {@link Unsubscribe}
 * is called when the last subscriber leaves — guaranteeing exactly one upstream
 * listener and no leak.
 */
export interface Multiplexer<Args extends readonly unknown[]> {
  subscribe(listener: (...args: Args) => void): Unsubscribe;
  /** Current subscriber count (0 means the upstream source is detached). */
  readonly size: number;
}

export function createMultiplexer<Args extends readonly unknown[]>(
  attach: (emit: (...args: Args) => void) => Unsubscribe,
): Multiplexer<Args> {
  const emitter = new TypedEventEmitter<{ event: Args }>();
  let detach: Unsubscribe | undefined;

  return {
    get size(): number {
      return emitter.listenerCount('event');
    },
    subscribe(listener: (...args: Args) => void): Unsubscribe {
      if (emitter.listenerCount('event') === 0) {
        detach = attach((...args: Args) => {
          emitter.emit('event', ...args);
        });
      }
      // Wrap in a fresh closure per subscription so identical listener references
      // are not collapsed by the emitter's Set — keeping the ref-count (and thus
      // the upstream detach lifecycle) accurate for every logical subscriber.
      const wrapped = (...args: Args): void => {
        listener(...args);
      };
      const off = emitter.on('event', wrapped);
      return () => {
        off();
        if (emitter.listenerCount('event') === 0 && detach !== undefined) {
          detach();
          detach = undefined;
        }
      };
    },
  };
}
