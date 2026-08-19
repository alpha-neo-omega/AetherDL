/**
 * Module: core/detection/dedupe (correlation engine)
 * Purpose: Correlate results across detectors (PROJECT_BIBLE.md §9.4/§9.5, Phase 4):
 *          group by stable identity, merge metadata (higher-priority base), remove
 *          duplicates, and raise confidence when multiple independent detectors
 *          corroborate the same media. Deterministic and local — no network.
 * Restrictions: Domain layer — pure. Conforms to the Deduplicator contract so it is
 *          a drop-in for the pipeline's dedupe stage.
 * Public API: CorrelatorOptions, createCorrelator.
 */
import type { MediaItem } from '@shared/types';
import type { Deduplicator } from '@core/detection/dedupe';
import {
  computeIdentityKey,
  mergeByPriority,
  type PriorityResolver,
} from '@core/detection/dedupe/dedupe';
import { clamp01 } from '@core/detection/scoring/scoring';

/** Confidence added per additional corroborating detector. */
const CORROBORATION_BONUS = 0.05;
/** Cap on how many extra corroborating detectors contribute a bonus. */
const MAX_CORROBORATION = 3;

export interface CorrelatorOptions {
  readonly priorityOf?: PriorityResolver;
}

export function createCorrelator(options: CorrelatorOptions = {}): Deduplicator {
  const priorityOf = options.priorityOf ?? ((): number => 0);
  const identityKey = (item: MediaItem): string =>
    computeIdentityKey({ url: item.url, container: item.container, kind: item.kind });

  return {
    identityKey,
    dedupe(items: readonly MediaItem[]): readonly MediaItem[] {
      const groups = new Map<string, MediaItem[]>();
      for (const item of items) {
        const key = identityKey(item);
        const group = groups.get(key);
        if (group === undefined) {
          groups.set(key, [item]);
        } else {
          group.push(item);
        }
      }

      const result: MediaItem[] = [];
      for (const group of groups.values()) {
        let merged = group[0]!;
        for (let i = 1; i < group.length; i += 1) {
          merged = mergeByPriority(merged, group[i]!, priorityOf);
        }
        const corroboratedBy = [...new Set(group.map((item) => item.detectedBy))];
        if (corroboratedBy.length > 1) {
          const bonus =
            Math.min(corroboratedBy.length - 1, MAX_CORROBORATION) * CORROBORATION_BONUS;
          merged = {
            ...merged,
            score: clamp01(merged.score + bonus),
            metadata: { ...merged.metadata, corroboratedBy },
          };
        }
        result.push(merged);
      }
      return result;
    },
  };
}
