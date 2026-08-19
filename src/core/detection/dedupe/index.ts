/**
 * Module: core/detection/dedupe
 * Purpose: Duplicate-removal contract via stable identity keys
 *          (PROJECT_BIBLE.md §9.5). Deterministic and local — no network hashing.
 * Restrictions: Domain layer — pure (§8.4).
 * Dependencies: shared/types.
 * Public API: Deduplicator.
 */
import type { MediaItem } from '@shared/types';

export interface Deduplicator {
  identityKey(item: MediaItem): string;
  dedupe(items: readonly MediaItem[]): readonly MediaItem[];
}
