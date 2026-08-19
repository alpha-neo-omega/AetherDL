/**
 * Module: core/query
 * Purpose: Filter / sort / search engine contract (PROJECT_BIBLE.md §4.12).
 *          Runs locally and synchronously over in-memory data.
 * Restrictions: Domain layer — pure (§8.4). No network.
 * Dependencies: shared/types.
 * Public API: SortDirection, SortSpec, FilterSpec, QueryEngine.
 */
import type { MediaItem, MediaKind } from '@shared/types';

export type SortDirection = 'asc' | 'desc';

export interface SortSpec {
  readonly key: 'title' | 'sizeBytes' | 'durationSec' | 'score' | 'discoveredAt';
  readonly direction: SortDirection;
}

export interface FilterSpec {
  readonly kind?: MediaKind;
  readonly container?: string;
  readonly host?: string;
  readonly text?: string;
}

export interface QueryEngine {
  apply(items: readonly MediaItem[], filter: FilterSpec, sort: SortSpec): readonly MediaItem[];
}
