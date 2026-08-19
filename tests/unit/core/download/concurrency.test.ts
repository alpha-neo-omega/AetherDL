import { describe, expect, it } from 'vitest';
import { createConcurrencyLimiter } from '@core/download/concurrency/concurrency';

describe('concurrency limiter', () => {
  it('bounds slots; tryAcquire returns undefined at capacity', () => {
    const limiter = createConcurrencyLimiter(2);
    const a = limiter.tryAcquire();
    const b = limiter.tryAcquire();
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(limiter.active).toBe(2);
    expect(limiter.tryAcquire()).toBeUndefined();
    a?.();
    expect(limiter.active).toBe(1);
    expect(limiter.tryAcquire()).toBeDefined();
  });

  it('acquire() waits and resumes when a slot is released', async () => {
    const limiter = createConcurrencyLimiter(1);
    const first = await limiter.acquire();
    let secondResolved = false;
    const secondPromise = limiter.acquire().then((release) => {
      secondResolved = true;
      return release;
    });
    await Promise.resolve();
    expect(secondResolved).toBe(false);
    first();
    const secondRelease = await secondPromise;
    expect(secondResolved).toBe(true);
    expect(limiter.active).toBe(1);
    secondRelease();
    expect(limiter.active).toBe(0);
  });

  it('release is idempotent', () => {
    const limiter = createConcurrencyLimiter(1);
    const release = limiter.tryAcquire();
    release?.();
    release?.();
    expect(limiter.active).toBe(0);
  });

  it('clamps the limit to at least 1', () => {
    const limiter = createConcurrencyLimiter(0);
    expect(limiter.limit).toBe(1);
  });

  it('moves its bound while in use, keeping held slots (§4.9, §10.3)', () => {
    const limiter = createConcurrencyLimiter(3);
    const held = [limiter.tryAcquire(), limiter.tryAcquire(), limiter.tryAcquire()];
    expect(limiter.active).toBe(3);

    // Lowering never interrupts what already runs; it only stops new work.
    limiter.setLimit(1);
    expect(limiter.limit).toBe(1);
    expect(limiter.active).toBe(3);
    expect(limiter.tryAcquire()).toBeUndefined();

    for (const release of held) {
      release?.();
    }
    expect(limiter.active).toBe(0);
    expect(limiter.tryAcquire()).toBeDefined();
    expect(limiter.tryAcquire()).toBeUndefined();
  });

  it('hands new slots to waiters when the bound is raised', async () => {
    const limiter = createConcurrencyLimiter(1);
    limiter.tryAcquire();
    let resumed = false;
    const waiting = limiter.acquire().then(() => {
      resumed = true;
    });
    await Promise.resolve();
    expect(resumed).toBe(false);

    limiter.setLimit(2);
    await waiting;

    expect(resumed).toBe(true);
    expect(limiter.active).toBe(2);
  });

  it('ignores a repeated bound and clamps a raised one', () => {
    const limiter = createConcurrencyLimiter(2);
    limiter.setLimit(2);
    expect(limiter.limit).toBe(2);
    limiter.setLimit(0);
    expect(limiter.limit).toBe(1);
  });
});
