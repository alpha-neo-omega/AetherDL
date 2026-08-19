/**
 * Module: core/detection/detectors (html5-video)
 * Purpose: Detect `<video>` elements, their `currentSrc`, and `<source>` children
 *          (PROJECT_BIBLE.md §9.2). Consumes DOM signals produced by the content
 *          script; never touches the live DOM. Blob-backed sources are left to the
 *          blob-media detector.
 * Restrictions: Depends only on the detector contract, pipeline input types, and
 *          shared/ (§9.2). No cross-detector imports, no browser globals.
 * Public API: createHtml5VideoDetector.
 */
import { getExtension } from '@shared/utils';
import type { Detector } from '@core/detection/detectors';
import type { DetectionContext, RawCandidate } from '@core/detection/pipeline';

const ID = 'html5-video';
const PRIORITY = 90;

function collect(context: DetectionContext): RawCandidate[] {
  const candidates: RawCandidate[] = [];
  context.domSignals.forEach((signal, index) => {
    const isVideoElement = signal.role === 'video';
    const isVideoSource = signal.role === 'source' && signal.parentRole === 'video';
    if (!isVideoElement && !isVideoSource) {
      return;
    }
    // Prefer a non-empty currentSrc; an empty currentSrc (not yet resolved) falls
    // back to the src attribute rather than masking it.
    const url =
      signal.currentSrc !== undefined && signal.currentSrc !== '' ? signal.currentSrc : signal.src;
    if (url === undefined || url === '' || url.startsWith('blob:')) {
      return;
    }
    const ext = getExtension(url);
    candidates.push({
      url,
      kind: 'video',
      detectedBy: ID,
      sourceKey: `${signal.role}:${index}`,
      ...(ext !== undefined && { container: ext }),
      ...(signal.type !== undefined && { mimeType: signal.type }),
      ...(signal.codecs !== undefined && { codec: signal.codecs }),
      // Propagate EME/DRM so the pipeline refuses encrypted media (§6) even when
      // this detector wins the correlation merge base.
      ...(signal.encrypted === true && { encrypted: true }),
      ...(signal.width !== undefined && { width: signal.width }),
      ...(signal.height !== undefined && { height: signal.height }),
      ...(signal.durationSec !== undefined && { durationSec: signal.durationSec }),
      ...(signal.title !== undefined && { title: signal.title }),
    });
  });
  return candidates;
}

export function createHtml5VideoDetector(): Detector {
  return {
    id: ID,
    name: 'HTML5 Video',
    priority: PRIORITY,
    enabled: true,
    canDetect: (context) =>
      context.domSignals.some(
        (signal) =>
          signal.role === 'video' || (signal.role === 'source' && signal.parentRole === 'video'),
      ),
    detect: (context) => Promise.resolve(collect(context)),
    metadata: () => ({
      id: ID,
      name: 'HTML5 Video',
      priority: PRIORITY,
      enabled: true,
      supportedKinds: ['video'],
    }),
  };
}
