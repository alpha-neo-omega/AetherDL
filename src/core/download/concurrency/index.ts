/**
 * Module: core/download/concurrency
 * Purpose: Bounded active-download pool contract (PROJECT_BIBLE.md §10.3, §10.9).
 * Restrictions: Domain layer — pure control logic (§8.4).
 * Dependencies: none.
 * Public API: ConcurrencyLimiter.
 */
/** Function returned on slot acquisition; call once to release the slot. */
export type ReleaseSlot = () => void;

export interface ConcurrencyLimiter {
  readonly limit: number;
  /** Number of slots currently held. */
  readonly active: number;
  /** Acquire a slot; resolves to a release function (waits if at capacity). */
  acquire(): Promise<ReleaseSlot>;
  /** Non-blocking acquire: a release function if a slot is free, else `undefined`. */
  tryAcquire(): ReleaseSlot | undefined;
}
