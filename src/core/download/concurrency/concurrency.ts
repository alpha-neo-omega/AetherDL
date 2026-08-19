/**
 * Module: core/download/concurrency (implementation)
 * Purpose: A bounded counting semaphore for download slots (PROJECT_BIBLE.md §10.3,
 *          §10.9). Each acquisition returns an idempotent release function.
 * Restrictions: Domain layer — pure control logic.
 * Public API: AdjustableConcurrencyLimiter, createConcurrencyLimiter.
 */
import type { ConcurrencyLimiter, ReleaseSlot } from '@core/download/concurrency';

/**
 * A limiter whose bound can move while it is in use. The *Maximum concurrent
 * downloads* setting can change mid-session (§4.9), and the limiter has to follow it
 * without losing the slots already held — replacing the limiter would forget them
 * and let more transfers run than the user allows (§10.3).
 */
export interface AdjustableConcurrencyLimiter extends ConcurrencyLimiter {
  setLimit(limit: number): void;
}

export function createConcurrencyLimiter(limit: number): AdjustableConcurrencyLimiter {
  let bound = Math.max(1, Math.floor(limit));
  let held = 0;
  const waiters: Array<(release: ReleaseSlot) => void> = [];

  const makeRelease = (): ReleaseSlot => {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = waiters.shift();
      if (next !== undefined) {
        // Hand the slot directly to the next waiter (held stays the same).
        next(makeRelease());
      } else {
        held -= 1;
      }
    };
  };

  return {
    get limit(): number {
      return bound;
    },
    get active(): number {
      return held;
    },
    setLimit(next: number): void {
      bound = Math.max(1, Math.floor(next));
      // Raising the bound hands the new slots to anyone already waiting. Lowering it
      // never interrupts a transfer already running; it simply stops new ones until
      // the count falls back under the bound.
      while (held < bound && waiters.length > 0) {
        const next_ = waiters.shift();
        if (next_ === undefined) {
          break;
        }
        held += 1;
        next_(makeRelease());
      }
    },
    acquire(): Promise<ReleaseSlot> {
      if (held < bound) {
        held += 1;
        return Promise.resolve(makeRelease());
      }
      return new Promise<ReleaseSlot>((resolve) => {
        waiters.push(resolve);
      });
    },
    tryAcquire(): ReleaseSlot | undefined {
      if (held < bound) {
        held += 1;
        return makeRelease();
      }
      return undefined;
    },
  };
}
