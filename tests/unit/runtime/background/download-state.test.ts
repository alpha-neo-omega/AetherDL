import { describe, expect, it } from 'vitest';
import { createDownloadRuntimeState } from '@runtime/background/download-state';

function makeState(times: number[] = []): ReturnType<typeof createDownloadRuntimeState> {
  let index = 0;
  return createDownloadRuntimeState({
    clock: () => {
      const value = times[index] ?? times[times.length - 1] ?? 0;
      index += 1;
      return value;
    },
  });
}

describe('background download runtime state', () => {
  it('starts empty, unhydrated and not scheduling', () => {
    const state = makeState([100]);
    const health = state.health();

    expect(health).toEqual({
      startedAt: 100,
      hydrated: false,
      hydratedJobs: 0,
      scheduling: false,
      outstanding: 0,
      pendingRetries: 0,
      enqueued: 0,
      started: 0,
      completed: 0,
      failed: 0,
      canceled: 0,
      retriesScheduled: 0,
      errors: 0,
      lastErrorAt: undefined,
      lastEventAt: undefined,
    });
  });

  it('records hydration and scheduling status', () => {
    const state = makeState([0]);
    state.markHydrated(4);
    state.setScheduling(true);

    expect(state.health().hydrated).toBe(true);
    expect(state.health().hydratedJobs).toBe(4);
    expect(state.health().scheduling).toBe(true);

    state.setScheduling(false);
    expect(state.health().scheduling).toBe(false);
  });

  it('counts lifecycle outcomes', () => {
    const state = makeState([0]);
    state.recordEnqueued(3);
    state.recordStarted();
    state.recordStarted();
    state.recordCompleted();
    state.recordFailed();
    state.recordCanceled();

    const health = state.health();
    expect(health.enqueued).toBe(3);
    expect(health.started).toBe(2);
    expect(health.completed).toBe(1);
    expect(health.failed).toBe(1);
    expect(health.canceled).toBe(1);
  });

  it('tracks pending retry schedules and drops them when cleared', () => {
    const state = makeState([0]);
    state.recordRetry({ taskId: 'a', attempt: 0, delayMs: 500, scheduledAt: 10 });
    state.recordRetry({ taskId: 'b', attempt: 1, delayMs: 900, scheduledAt: 20 });

    expect(state.retries().map((retry) => retry.taskId)).toEqual(['a', 'b']);
    expect(state.retryFor('b')).toEqual({
      taskId: 'b',
      attempt: 1,
      delayMs: 900,
      scheduledAt: 20,
    });
    expect(state.health().pendingRetries).toBe(2);
    expect(state.health().retriesScheduled).toBe(2);

    state.clearRetry('a');
    expect(state.retries().map((retry) => retry.taskId)).toEqual(['b']);
    // The lifetime counter keeps counting even as pending schedules drain.
    expect(state.health().retriesScheduled).toBe(2);
  });

  it('replaces an existing schedule for the same job', () => {
    const state = makeState([0]);
    state.recordRetry({ taskId: 'a', attempt: 0, delayMs: 500, scheduledAt: 10 });
    state.recordRetry({ taskId: 'a', attempt: 1, delayMs: 1000, scheduledAt: 20 });

    expect(state.retries()).toHaveLength(1);
    expect(state.retryFor('a')?.attempt).toBe(1);
  });

  it('clearing an unknown retry is a no-op', () => {
    const state = makeState([0]);
    state.clearRetry('nope');
    expect(state.retries()).toEqual([]);
  });

  it('balances outstanding operations and never goes negative', () => {
    const state = makeState([0]);
    state.beginOperation();
    state.beginOperation();
    expect(state.outstandingCount()).toBe(2);

    state.endOperation();
    state.endOperation();
    state.endOperation();
    expect(state.outstandingCount()).toBe(0);
    expect(state.health().outstanding).toBe(0);
  });

  it('records errors with the clock', () => {
    const state = makeState([0, 5, 7]);
    state.recordError();

    expect(state.health().errors).toBe(1);
    expect(state.health().lastErrorAt).toBe(5);
  });

  it('stamps the last event time on every recorded event', () => {
    const state = makeState([0, 42]);
    expect(state.health().lastEventAt).toBeUndefined();
    state.recordCompleted();
    expect(state.health().lastEventAt).toBe(42);
  });
});
