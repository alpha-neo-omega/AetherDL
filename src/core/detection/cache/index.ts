/**
 * Module: core/detection/cache
 * Purpose: Per-tab, in-memory, bounded detection-result cache contract
 *          (PROJECT_BIBLE.md §9.9). Never persisted to disk (§14). Implementation
 *          in ./cache.
 * Restrictions: Domain layer — pure state container; invalidated on navigation.
 * Dependencies: shared/types.
 * Public API: CacheStats, DetectionCache.
 */
import type { MediaItem } from '@shared/types';

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly size: number;
}

export interface DetectionCache {
  /**
   * Fetch cached results for a tab. When `pageUrl` is provided and differs from the
   * cached page, the entry is treated as stale (miss) — page navigation invalidates.
   */
  get(tabId: number, pageUrl?: string): readonly MediaItem[] | undefined;
  set(tabId: number, items: readonly MediaItem[], pageUrl?: string): void;
  invalidate(tabId: number): void;
  invalidateAll(): void;
  /** Evict expired entries (called opportunistically); returns count removed. */
  cleanup(): number;
  stats(): CacheStats;
}
