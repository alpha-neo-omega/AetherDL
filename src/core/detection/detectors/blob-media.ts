/**
 * Module: core/detection/detectors (blob-media)
 * Purpose: Report observable `blob:`-backed `<video>`/`<audio>` media
 *          (PROJECT_BIBLE.md §9.2, §5.4). Best-effort only: it REPORTS the blob
 *          source; it does NOT reconstruct blobs, engage MediaSource, or bypass any
 *          browser limitation (§5.4, DO-NOT list).
 * Restrictions: Depends only on the detector contract, pipeline input types, and
 *          shared/ (§9.2). No cross-detector imports, no browser globals.
 * Public API: createBlobMediaDetector.
 */
import type { MediaKind } from '@shared/types';
import type { Detector } from '@core/detection/detectors';
import type { DetectionContext, DomSignal, RawCandidate } from '@core/detection/pipeline';

const ID = 'blob-media';
const PRIORITY = 40;

function isBlobSignal(src: string | undefined): boolean {
  return src !== undefined && src.startsWith('blob:');
}

/** Derive the media kind: media elements by role, `<source>` by parent role. */
function deriveKind(signal: DomSignal): MediaKind | undefined {
  if (signal.role === 'video' || signal.role === 'audio') {
    return signal.role;
  }
  if (
    signal.role === 'source' &&
    (signal.parentRole === 'video' || signal.parentRole === 'audio')
  ) {
    return signal.parentRole;
  }
  return undefined;
}

function hasBlobUrl(signal: DomSignal): boolean {
  return isBlobSignal(signal.src) || isBlobSignal(signal.currentSrc);
}

function collect(context: DetectionContext): RawCandidate[] {
  const candidates: RawCandidate[] = [];
  context.domSignals.forEach((signal, index) => {
    const kind = deriveKind(signal);
    if (kind === undefined) {
      return;
    }
    const url = isBlobSignal(signal.currentSrc)
      ? signal.currentSrc
      : isBlobSignal(signal.src)
        ? signal.src
        : undefined;
    if (url === undefined) {
      return;
    }
    candidates.push({
      url,
      kind,
      detectedBy: ID,
      isBlob: true,
      sourceKey: `blob:${index}`,
      ...(signal.type !== undefined && { mimeType: signal.type }),
      ...(signal.width !== undefined && { width: signal.width }),
      ...(signal.height !== undefined && { height: signal.height }),
      ...(signal.durationSec !== undefined && { durationSec: signal.durationSec }),
      ...(signal.title !== undefined && { title: signal.title }),
    });
  });
  return candidates;
}

export function createBlobMediaDetector(): Detector {
  return {
    id: ID,
    name: 'Blob Media',
    priority: PRIORITY,
    enabled: true,
    // Aligned with detect(): only signals that resolve to a media kind AND carry a
    // blob URL — no false-positive canDetect for unclassifiable blob signals.
    canDetect: (context) =>
      context.domSignals.some((signal) => deriveKind(signal) !== undefined && hasBlobUrl(signal)),
    detect: (context) => Promise.resolve(collect(context)),
    metadata: () => ({
      id: ID,
      name: 'Blob Media',
      priority: PRIORITY,
      enabled: true,
      supportedKinds: ['video', 'audio'],
    }),
  };
}
