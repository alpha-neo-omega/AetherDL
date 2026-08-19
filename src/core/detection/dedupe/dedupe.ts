/**
 * Module: core/detection/dedupe (implementation)
 * Purpose: Deterministic, local duplicate removal via stable identity keys
 *          (PROJECT_BIBLE.md §9.5). No network hashing.
 * Restrictions: Domain layer — pure.
 * Public API: IdentityParts, computeIdentityKey, createDeduplicator.
 */
import type { MediaItem, MediaKind } from '@shared/types';
import { normalizeUrl } from '@shared/utils';
import type { Deduplicator } from '@core/detection/dedupe';

export interface IdentityParts {
  readonly url: string;
  readonly container: string | undefined;
  readonly kind: MediaKind;
}

/**
 * Compute a stable identity key from normalized URL + container + kind (§9.5). A
 * single URL has no legitimate distinct-resolution variants in Phase 3 (adaptive
 * manifests are §5.5 / Phase 4), so resolution is NOT part of identity — otherwise
 * the same resource reported once with dimensions and once without would fail to
 * deduplicate (§4.6). `blob:` URLs keep their opaque body as identity.
 */
export function computeIdentityKey(parts: IdentityParts): string {
  const normalized = normalizeUrl(parts.url) ?? parts.url;
  return [normalized, parts.container ?? '', parts.kind].join('|');
}

/** Resolves a detector id to its priority; higher wins the merge base (§9.4). */
export type PriorityResolver = (detectedBy: string) => number;

/**
 * Merge two items that share an identity. Per §9.4/§9.5 the base is the candidate
 * from the higher-PRIORITY detector (score breaks ties); its present fields win and
 * the other fills gaps. Since a built MediaItem omits absent optional keys,
 * `{ ...other, ...base }` yields exactly "base wins, gaps filled" (no info lost).
 * Exported for reuse by the correlation engine (§ Phase 4).
 */
export function mergeByPriority(
  base: MediaItem,
  other: MediaItem,
  priorityOf: PriorityResolver,
): MediaItem {
  const basePriority = priorityOf(base.detectedBy);
  const otherPriority = priorityOf(other.detectedBy);
  const baseWins =
    basePriority !== otherPriority ? basePriority >= otherPriority : base.score >= other.score;
  const merged = baseWins ? { ...other, ...base } : { ...base, ...other };

  // Safety invariant (§6/§5.4): an `unsupported` (DRM/EME/blob/MediaSource) refusal
  // is STICKY — a higher-priority "supported" candidate can never upgrade it. If
  // either input refused the resource, the merged item stays refused and carries a
  // reason, regardless of which detector won the field merge.
  const refusal =
    base.status === 'unsupported' ? base : other.status === 'unsupported' ? other : undefined;
  if (refusal !== undefined && merged.status !== 'unsupported') {
    return {
      ...merged,
      status: 'unsupported',
      ...(refusal.unsupportedReason !== undefined && {
        unsupportedReason: refusal.unsupportedReason,
      }),
    };
  }
  return merged;
}

/**
 * Create a deduplicator. `priorityOf` maps a detector id to its priority so the
 * higher-priority candidate becomes the merge base (§9.4); it defaults to a
 * constant, in which case score alone decides.
 */
export function createDeduplicator(priorityOf: PriorityResolver = () => 0): Deduplicator {
  const identityKey = (item: MediaItem): string =>
    computeIdentityKey({ url: item.url, container: item.container, kind: item.kind });

  return {
    identityKey,
    dedupe(items: readonly MediaItem[]): readonly MediaItem[] {
      const merged = new Map<string, MediaItem>();
      for (const item of items) {
        const key = identityKey(item);
        const existing = merged.get(key);
        merged.set(
          key,
          existing === undefined ? item : mergeByPriority(existing, item, priorityOf),
        );
      }
      return [...merged.values()];
    },
  };
}
