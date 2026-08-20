/**
 * Module: core/detection/cache (implementation)
 * Purpose: Per-tab, in-memory, bounded (LRU + max-age) detection cache
 *          (PROJECT_BIBLE.md §9.9, §12.5). Never persisted (§14).
 * Restrictions: Domain layer — pure state container; clock injected for determinism.
 * Public API: DetectionCacheOptions, createDetectionCache.
 */
import type { MediaItem } from '@shared/types';
import type { CacheStats, DetectionCache } from '@core/detection/cache';

export interface DetectionCacheOptions {
  readonly clock: () => number;
  /** Maximum number of tabs tracked; least-recently-used is evicted beyond this. */
  readonly maxTabs: number;
  /** Maximum entry age in milliseconds before it is considered stale. */
  readonly maxAgeMs: number;
}

interface CacheEntry {
  readonly items: readonly MediaItem[];
  readonly pageUrl: string | undefined;
  readonly storedAt: number;
}

export function createDetectionCache(options: DetectionCacheOptions): DetectionCache {
  const { clock, maxTabs, maxAgeMs } = options;
  const entries = new Map<number, CacheEntry>();
  let hits = 0;
  let misses = 0;

  const isExpired = (entry: CacheEntry): boolean => clock() - entry.storedAt > maxAgeMs;

  return {
    get(tabId: number, pageUrl?: string): readonly MediaItem[] | undefined {
      const entry = entries.get(tabId);
      if (entry === undefined) {
        misses += 1;
        return undefined;
      }
      if (isExpired(entry)) {
        entries.delete(tabId);
        misses += 1;
        return undefined;
      }
      // Navigation invalidates: a changed page URL makes the entry stale.
      if (pageUrl !== undefined && entry.pageUrl !== undefined && entry.pageUrl !== pageUrl) {
        entries.delete(tabId);
        misses += 1;
        return undefined;
      }
      // LRU touch: re-insert to move to the most-recently-used position.
      entries.delete(tabId);
      entries.set(tabId, entry);
      hits += 1;
      return entry.items;
    },

    set(tabId: number, items: readonly MediaItem[], pageUrl?: string): void {
      entries.delete(tabId);
      // Drop what has already expired before deciding what to evict. Otherwise a
      // stale entry keeps a slot and a LIVE one is evicted in its place, since
      // expiry is only noticed when an entry is read (§9.9, §12.5).
      for (const [id, entry] of [...entries.entries()]) {
        if (isExpired(entry)) {
          entries.delete(id);
        }
      }
      entries.set(tabId, { items, pageUrl, storedAt: clock() });
      while (entries.size > maxTabs) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        entries.delete(oldest);
      }
    },

    invalidate(tabId: number): void {
      entries.delete(tabId);
    },

    invalidateAll(): void {
      entries.clear();
    },

    cleanup(): number {
      let removed = 0;
      for (const [tabId, entry] of [...entries.entries()]) {
        if (isExpired(entry)) {
          entries.delete(tabId);
          removed += 1;
        }
      }
      return removed;
    },

    stats(): CacheStats {
      return { hits, misses, size: entries.size };
    },
  };
}
