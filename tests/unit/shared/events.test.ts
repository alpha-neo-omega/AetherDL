import { describe, expect, it, vi } from 'vitest';
import { TypedEventEmitter, createMultiplexer } from '@shared/utils';

describe('shared/utils TypedEventEmitter', () => {
  it('subscribes and emits to listeners', () => {
    const emitter = new TypedEventEmitter<{ ping: [number] }>();
    const listener = vi.fn();
    emitter.on('ping', listener);
    emitter.emit('ping', 7);
    expect(listener).toHaveBeenCalledWith(7);
  });

  it('unsubscribes via the returned function', () => {
    const emitter = new TypedEventEmitter<{ ping: [] }>();
    const listener = vi.fn();
    const off = emitter.on('ping', listener);
    off();
    emitter.emit('ping');
    expect(listener).not.toHaveBeenCalled();
    expect(emitter.listenerCount('ping')).toBe(0);
  });

  it('once fires exactly once', () => {
    const emitter = new TypedEventEmitter<{ ping: [] }>();
    const listener = vi.fn();
    emitter.once('ping', listener);
    emitter.emit('ping');
    emitter.emit('ping');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('off removes a specific listener and counts listeners', () => {
    const emitter = new TypedEventEmitter<{ ping: [] }>();
    const a = vi.fn();
    const b = vi.fn();
    emitter.on('ping', a);
    emitter.on('ping', b);
    expect(emitter.listenerCount('ping')).toBe(2);
    expect(emitter.listenerCount()).toBe(2);
    emitter.off('ping', a);
    emitter.emit('ping');
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledOnce();
  });

  it('clear removes all listeners for an event and globally', () => {
    const emitter = new TypedEventEmitter<{ a: []; b: [] }>();
    emitter.on('a', vi.fn());
    emitter.on('b', vi.fn());
    emitter.clear('a');
    expect(emitter.listenerCount('a')).toBe(0);
    expect(emitter.listenerCount('b')).toBe(1);
    emitter.clear();
    expect(emitter.listenerCount()).toBe(0);
  });
});

describe('shared/utils createMultiplexer', () => {
  it('attaches once, fans out, and detaches at zero subscribers', () => {
    let attached = 0;
    let detached = 0;
    let emit: ((n: number) => void) | undefined;
    const mux = createMultiplexer<[number]>((emitFn) => {
      attached += 1;
      emit = emitFn;
      return () => {
        detached += 1;
        emit = undefined;
      };
    });

    const first = vi.fn();
    const second = vi.fn();
    const offFirst = mux.subscribe(first);
    const offSecond = mux.subscribe(second);
    expect(attached).toBe(1);
    expect(mux.size).toBe(2);

    emit?.(9);
    expect(first).toHaveBeenCalledWith(9);
    expect(second).toHaveBeenCalledWith(9);

    offFirst();
    expect(detached).toBe(0);
    offSecond();
    expect(detached).toBe(1);
    expect(mux.size).toBe(0);
  });

  it('counts identical listener references as distinct subscriptions', () => {
    let detached = 0;
    let emit: ((n: number) => void) | undefined;
    const mux = createMultiplexer<[number]>((emitFn) => {
      emit = emitFn;
      return () => {
        detached += 1;
        emit = undefined;
      };
    });

    const shared = vi.fn();
    const offA = mux.subscribe(shared);
    const offB = mux.subscribe(shared);
    expect(mux.size).toBe(2);

    // Dropping one subscription must NOT detach the upstream source.
    offA();
    expect(detached).toBe(0);
    expect(emit).toBeDefined();

    // The surviving subscription still receives events.
    emit?.(42);
    expect(shared).toHaveBeenCalledWith(42);

    offB();
    expect(detached).toBe(1);
    expect(mux.size).toBe(0);
  });
});

describe('TypedEventEmitter: one subscriber cannot break the others (§20.7)', () => {
  // With no owner listening the failure is rethrown on a later microtask, where it
  // reaches the context's own error reporting. That path is deliberately not asserted
  // here: a rethrow from a microtask surfaces as an unhandled error in the runner,
  // and a test that "proves" it would only be proving its own plumbing.

  it('delivers to every listener even when one throws', () => {
    // Regression: the throw aborted the dispatch, so later listeners were skipped,
    // and it unwound into whatever emitted — in the download manager that meant the
    // scheduler's next step never ran and the queue stalled.
    const emitter = new TypedEventEmitter<{ tick: [number] }>();
    const before = vi.fn();
    const after = vi.fn();
    emitter.on('tick', before);
    emitter.on('tick', () => {
      throw new Error('subscriber blew up');
    });
    emitter.on('tick', after);

    expect(() => {
      emitter.emit('tick', 1);
    }).not.toThrow();
    expect(before).toHaveBeenCalledWith(1);
    expect(after).toHaveBeenCalledWith(1);
  });

  it('reports the failure to the owner rather than swallowing it', () => {
    const onListenerError = vi.fn();
    const emitter = new TypedEventEmitter<{ tick: [] }>({ onListenerError });
    const failure = new Error('subscriber blew up');
    emitter.on('tick', () => {
      throw failure;
    });

    emitter.emit('tick');

    expect(onListenerError).toHaveBeenCalledWith(failure, 'tick');
  });

  it('keeps dispatching when the reporter itself throws', () => {
    const after = vi.fn();
    const emitter = new TypedEventEmitter<{ tick: [] }>({
      onListenerError: () => {
        throw new Error('the reporter blew up too');
      },
    });
    emitter.on('tick', () => {
      throw new Error('subscriber blew up');
    });
    emitter.on('tick', after);

    expect(() => {
      emitter.emit('tick');
    }).not.toThrow();
    expect(after).toHaveBeenCalled();
  });
});
