/**
 * Module: core/detection/quality (implementation)
 * Purpose: Deterministic quality classification from KNOWN metadata only
 *          (PROJECT_BIBLE.md §9.8). Never guesses; unknown dimensions → 'unknown'.
 * Restrictions: Domain layer — pure. Manifest variant PARSING (QualityParser.
 *          parseVariants) requires fetching/parsing and is deferred to Phase 5.
 * Public API: classifyQuality.
 */
import type { MediaKind, QualityLabel } from '@shared/types';

/** Standard resolution tiers keyed on frame height (descending). */
const HEIGHT_TIERS: ReadonlyArray<readonly [number, QualityLabel]> = [
  [2160, '2160p'],
  [1440, '1440p'],
  [1080, '1080p'],
  [720, '720p'],
  [480, '480p'],
  [360, '360p'],
  [240, '240p'],
  [144, '144p'],
];

/**
 * Classify quality from the media kind and (optional) frame height. Audio is
 * `audio-only`; a missing or sub-144p height yields `unknown` (no guessing).
 */
export function classifyQuality(kind: MediaKind, height: number | undefined): QualityLabel {
  if (kind === 'audio') {
    return 'audio-only';
  }
  if (height === undefined) {
    return 'unknown';
  }
  for (const [minHeight, label] of HEIGHT_TIERS) {
    if (height >= minHeight) {
      return label;
    }
  }
  return 'unknown';
}
