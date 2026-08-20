/**
 * Module: core/detection/pipeline (implementation)
 * Purpose: Deterministic detection pipeline (PROJECT_BIBLE.md §9.3): validate →
 *          build MediaItem (normalize + metadata) → score → deduplicate → sort.
 * Restrictions: Domain layer — pure; clock injected for deterministic timestamps.
 * Public API: PipelineOptions, createDetectionPipeline.
 */
import type { PlatformError } from '@shared/result/errors';
import type { MediaItem } from '@shared/types';
import { UNTITLED_MEDIA_TITLE } from '@shared/constants';
import { getHost } from '@shared/utils';
import type { Deduplicator } from '@core/detection/dedupe';
import { computeIdentityKey } from '@core/detection/dedupe/dedupe';
import type { MetadataExtractor } from '@core/detection/metadata';
import { classifyDelivery } from '@core/detection/metadata/classify';
import { classifyQuality } from '@core/detection/quality/quality';
import type { DetectionContext, DetectionPipeline, RawCandidate } from '@core/detection/pipeline';
import type { Scorer } from '@core/detection/scoring';
import { validateCandidate } from '@core/detection/pipeline/validate';

export interface PipelineOptions {
  readonly scorer: Scorer;
  readonly deduplicator: Deduplicator;
  readonly metadataExtractor: MetadataExtractor;
  readonly clock: () => number;
  /** Invoked when a candidate is rejected during validation (for event surfacing). */
  readonly onReject?: (candidate: RawCandidate, error: PlatformError) => void;
}

/** Build a scored-at-0 MediaItem from a validated candidate + derived metadata. */
function buildDraft(
  candidate: RawCandidate,
  extracted: Partial<MediaItem>,
  context: DetectionContext,
  discoveredAt: number,
): MediaItem {
  const container = candidate.container ?? extracted.container;
  const extension = extracted.extension ?? candidate.container;
  const mimeType = candidate.mimeType ?? extracted.mimeType;
  const filename = candidate.filename ?? extracted.filename;
  const title = candidate.title ?? filename ?? context.documentTitle ?? UNTITLED_MEDIA_TITLE;
  // `blob:` URLs have an empty host; fall back to the page host (the media belongs
  // to the page) so origin grouping stays meaningful (§4.2).
  const sourceHost = getHost(candidate.originalUrl ?? candidate.url);
  const originHost =
    sourceHost !== undefined && sourceHost !== '' ? sourceHost : (getHost(context.pageUrl) ?? '');
  const id = computeIdentityKey({ url: candidate.url, container, kind: candidate.kind });

  const delivery = classifyDelivery(candidate);
  const quality = classifyQuality(candidate.kind, candidate.height);

  // Classification of downloadability (§5.4/§6.3, §9.1). Encrypted (EME) media is
  // DRM → unsupported. Blob/MediaSource-backed media is reported but unsupported —
  // it cannot be resolved within the security model (§13); no reconstruction.
  const encrypted = candidate.encrypted === true;
  const unresolvable = candidate.isBlob === true || delivery === 'media-source';
  const status = encrypted || unresolvable ? 'unsupported' : 'supported';
  const unsupportedReason = encrypted
    ? 'Encrypted (DRM/EME) media is not supported.'
    : unresolvable
      ? 'Blob / MediaSource media cannot be resolved within the extension security model.'
      : undefined;

  return {
    id,
    kind: candidate.kind,
    status,
    ...(unsupportedReason !== undefined && { unsupportedReason }),
    title,
    url: candidate.url,
    originHost,
    detectedBy: candidate.detectedBy,
    delivery,
    score: 0,
    discoveredAt,
    ...(quality !== 'unknown' && { quality }),
    ...(candidate.originalUrl !== undefined && { originalUrl: candidate.originalUrl }),
    ...(container !== undefined && { container }),
    ...(extension !== undefined && { extension }),
    ...(mimeType !== undefined && { mimeType }),
    ...(filename !== undefined && { filename }),
    ...(candidate.codec !== undefined && { codec: candidate.codec }),
    ...(candidate.width !== undefined && { width: candidate.width }),
    ...(candidate.height !== undefined && { height: candidate.height }),
    ...(candidate.durationSec !== undefined && { durationSec: candidate.durationSec }),
    ...(candidate.bitrateKbps !== undefined && { bitrateKbps: candidate.bitrateKbps }),
    ...(candidate.sizeBytes !== undefined && { sizeBytes: candidate.sizeBytes }),
  };
}

/** Deterministic ordering: score desc, then host, then URL (§9.4). */
function compareItems(a: MediaItem, b: MediaItem): number {
  if (b.score !== a.score) {
    return b.score - a.score;
  }
  const host = a.originHost.localeCompare(b.originHost);
  if (host !== 0) {
    return host;
  }
  return a.url.localeCompare(b.url);
}

export function createDetectionPipeline(options: PipelineOptions): DetectionPipeline {
  const { scorer, deduplicator, metadataExtractor, clock, onReject } = options;

  return {
    async run(
      context: DetectionContext,
      candidates: readonly RawCandidate[],
    ): Promise<readonly MediaItem[]> {
      const built: MediaItem[] = [];
      const discoveredAt = clock();
      for (const candidate of candidates) {
        const validation = validateCandidate(candidate);
        if (!validation.ok) {
          onReject?.(candidate, validation.error);
          continue;
        }
        const extracted = await metadataExtractor.extract({
          url: candidate.url,
          kind: candidate.kind,
        });
        const draft = buildDraft(candidate, extracted, context, discoveredAt);
        built.push({ ...draft, score: scorer.score(draft) });
      }
      const deduped = deduplicator.dedupe(built);
      return [...deduped].sort(compareItems);
    },
  };
}
