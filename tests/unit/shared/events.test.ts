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
