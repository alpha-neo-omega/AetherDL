import { describe, expect, it } from 'vitest';
import { QueueError } from '@core/download/errors';
import { assertTransition, canTransition, TERMINAL_STATES } from '@core/download/state';

describe('download state machine', () => {
  it('permits the documented lifecycle transitions', () => {
    expect(canTransition('queued', 'preparing')).toBe(true);
    expect(canTransition('preparing', 'active')).toBe(true);
    expect(canTransition('active', 'completed')).toBe(true);
    expect(canTransition('active', 'paused')).toBe(true);
    expect(canTransition('active', 'canceling')).toBe(true);
    expect(canTransition('canceling', 'canceled')).toBe(true);
    expect(canTransition('failed', 'queued')).toBe(true);
    expect(canTransition('failed', 'retrying')).toBe(true);
    expect(canTransition('retrying', 'queued')).toBe(true);
    expect(canTransition('paused', 'queued')).toBe(true);
  });

  it('rejects illegal transitions', () => {
    expect(canTransition('completed', 'active')).toBe(false);
    expect(canTransition('queued', 'completed')).toBe(false);
    expect(canTransition('canceled', 'active')).toBe(false);
    expect(canTransition('active', 'removed')).toBe(false);
    expect(canTransition('removed', 'queued')).toBe(false);
  });

  it('assertTransition throws QueueError only on illegal transitions', () => {
    expect(() => assertTransition('queued', 'preparing')).not.toThrow();
    expect(() => assertTransition('completed', 'active')).toThrow(QueueError);
  });

  it('marks completed/canceled/removed terminal (failed is not)', () => {
    expect(TERMINAL_STATES.has('completed')).toBe(true);
    expect(TERMINAL_STATES.has('canceled')).toBe(true);
    expect(TERMINAL_STATES.has('removed')).toBe(true);
    expect(TERMINAL_STATES.has('failed')).toBe(false);
  });
});
