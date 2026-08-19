/**
 * Module: core/detection/detectors (media-source)
 * Purpose: Report the PRESENCE of MediaSource (MSE) / EME-backed media on a page
 *          (PROJECT_BIBLE.md §5.4, §6). Reports presence and classifies delivery
 *          only: it does NOT inspect SourceBuffers, reconstruct media, or engage
 *          any key system. EME-flagged media is marked encrypted (→ DRM, §6).
 * Restrictions: Depends only on the detector contract, pipeline input types, and
 *          shared/ (§9.2). No cross-detector imports, no browser globals.
 * Public API: createMediaSourceDetector.
 */
import type { MediaKind } from '@shared/types';
import type { Detector } from '@core/detection/detectors';
import type { DetectionContext, DomSignal, RawCandidate } from '@core/detection/pipeline';

const ID = 'media-source';
const PRIORITY = 45;

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

function usesMediaSource(signal: DomSignal): boolean {
  return signal.mediaSource === true || signal.encrypted === true;
}

function collect(context: DetectionContext): RawCandidate[] {
  const candidates: RawCandidate[] = [];
  context.domSignals.forEach((signal, index) => {
    if (!usesMediaSource(signal)) {
      return;
    }
    const kind = deriveKind(signal);
    if (kind === undefined) {
      return;
    }
    const url = signal.currentSrc ?? signal.src;
    if (url === undefined || url === '') {
      return;
    }
    candidates.push({
      url,
      kind,
      detectedBy: ID,
      delivery: 'media-source',
      sourceKey: `mse:${index}`,
      ...(url.startsWith('blob:') && { isBlob: true }),
      ...(signal.encrypted === true && { encrypted: true }),
      ...(signal.type !== undefined && { mimeType: signal.type }),
      ...(signal.width !== undefined && { width: signal.width }),
      ...(signal.height !== undefined && { height: signal.height }),
      ...(signal.durationSec !== undefined && { durationSec: signal.durationSec }),
      ...(signal.title !== undefined && { title: signal.title }),
    });
  });
  return candidates;
}

export function createMediaSourceDetector(): Detector {
  return {
    id: ID,
    name: 'MediaSource',
    priority: PRIORITY,
    enabled: true,
    canDetect: (context) =>
      context.domSignals.some(
        (signal) => usesMediaSource(signal) && deriveKind(signal) !== undefined,
      ),
    detect: (context) => Promise.resolve(collect(context)),
    metadata: () => ({
      id: ID,
      name: 'MediaSource',
      priority: PRIORITY,
      enabled: true,
      supportedKinds: ['video', 'audio'],
    }),
  };
}
