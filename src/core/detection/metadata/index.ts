/**
 * Module: core/detection/metadata
 * Purpose: Best-effort metadata extraction contract (PROJECT_BIBLE.md §4.2, §9.6).
 *          Missing fields remain unknown; never fabricated.
 * Restrictions: Domain layer — pure (§8.4).
 * Dependencies: shared/types.
 * Public API: MetadataExtractor.
 */
import type { MediaItem } from '@shared/types';

export interface MetadataExtractor {
  extract(source: Pick<MediaItem, 'url' | 'kind'>): Promise<Partial<MediaItem>>;
}
