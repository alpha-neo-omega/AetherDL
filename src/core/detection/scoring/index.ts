/**
 * Module: core/detection/scoring
 * Purpose: Media-scoring contract (PROJECT_BIBLE.md §9.7). Transparent,
 *          deterministic, no remote data.
 * Restrictions: Domain layer — pure (§8.4).
 * Dependencies: shared/types.
 * Public API: Scorer.
 */
import type { MediaItem } from '@shared/types';

export interface Scorer {
  score(item: MediaItem): number;
}
