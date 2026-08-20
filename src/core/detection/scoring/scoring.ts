/**
 * Module: core/detection/scoring (implementation)
 * Purpose: Deterministic, explainable confidence scoring (PROJECT_BIBLE.md §9.7).
 *          No remote data; same item → same score.
 * Restrictions: Domain layer — pure.
 * Public API: createScorer.
 */
import { UNTITLED_MEDIA_TITLE } from '@shared/constants';
import type { MediaItem } from '@shared/types';
import type { Scorer } from '@core/detection/scoring';

/**
 * Source-reliability weights by detector (§9.7). Direct URLs and HTML5 elements are
 * unambiguous; blob-backed media is best-effort and thus weighted lower (§5.4).
 */
const SOURCE_RELIABILITY: Readonly<Record<string, number>> = {
  'direct-url': 0.35,
  'html5-video': 0.35,
  'html5-audio': 0.3,
  'blob-media': 0.15,
};

/** Clamp a raw score into [0,1]. Exported for direct branch testing. */
export function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

export function createScorer(): Scorer {
  return {
    score(item: MediaItem): number {
      let score = SOURCE_RELIABILITY[item.detectedBy] ?? 0.2;
      if (item.mimeType !== undefined) {
        score += 0.1;
      }
      if (item.width !== undefined && item.height !== undefined) {
        score += 0.15;
      }
      if (item.durationSec !== undefined) {
        score += 0.1;
      }
      if (item.sizeBytes !== undefined) {
        score += 0.05;
      }
      // A REAL title, not the placeholder every unnamed item carries. `title` is a
      // required field, so rewarding its mere presence added the same constant to
      // every score and ranked nothing (§9.7).
      if (item.title !== '' && item.title !== UNTITLED_MEDIA_TITLE) {
        score += 0.05;
      }
      // Resolution prominence: larger media is more likely the primary content.
      if (item.height !== undefined) {
        score += Math.min(item.height / 2160, 1) * 0.2;
      }
      return clamp01(score);
    },
  };
}
