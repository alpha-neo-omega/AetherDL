import { describe, expect, it } from 'vitest';
import { createProgressTracker } from '@core/download/progress/progress';

describe('progress tracker', () => {
  it('records bytes and computes ratio; no rate from a single sample', () => {
    const tracker = createProgressTracker(() => 0);
    tracker.record('a', 50, 100);
    const snap = tracker.snapshot('a');
    expect(snap?.received).toBe(50);
    expect(snap?.ratio).toBe(0.5);
    expect(snap?.bytesPerSec).toBeUndefined();
    expect(snap?.etaSec).toBeUndefined();
  });

  it('derives transfer rate and ETA from two samples', () => {
    let now = 0;
    const tracker = createProgressTracker(() => now);
    tracker.record('a', 0, 100);
    now = 1000;
    tracker.record('a', 50, 100);
    const snap = tracker.snapshot('a');
    expect(snap?.bytesPerSec).toBe(50);
    expect(snap?.etaSec).toBe(1);
  });

  it('omits ratio and ETA when total is unknown (honest, §2.8)', () => {
    const tracker = createProgressTracker(() => 0);
    tracker.record('a', 50);
    const snap = tracker.snapshot('a');
    expect(snap?.ratio).toBeUndefined();
    expect(snap?.etaSec).toBeUndefined();
  });

  it('aggregates overall progress and supports remove/clear', () => {
    const tracker = createProgressTracker(() => 0);
    tracker.record('a', 50, 100);
    tracker.record('b', 25, 100);
    const overall = tracker.overall();
    expect(overall.received).toBe(75);
    expect(overall.total).toBe(200);
    expect(overall.jobs).toBe(2);
    tracker.remove('a');
    expect(tracker.snapshot('a')).toBeUndefined();
    tracker.clear();
    expect(tracker.overall().jobs).toBe(0);
  });
});
