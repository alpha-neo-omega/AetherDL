/**
 * Module: core/detection/metadata (delivery classification)
 * Purpose: Classify how media is delivered — HLS / DASH / progressive / blob /
 *          HTML5 / direct / media-source (PROJECT_BIBLE.md §5.5). Classification
 *          only; deterministic; uses the detector hint and container.
 * Restrictions: Domain layer — pure.
 * Public API: classifyDelivery.
 */
import type { DeliveryType } from '@shared/types';
import type { RawCandidate } from '@core/detection/pipeline';

export function classifyDelivery(candidate: RawCandidate): DeliveryType {
  if (candidate.delivery !== undefined) {
    return candidate.delivery;
  }
  const container = candidate.container?.toLowerCase();
  if (container === 'm3u8' || container === 'm3u') {
    return 'hls';
  }
  if (container === 'mpd') {
    return 'dash';
  }
  if (candidate.isBlob === true) {
    return 'blob';
  }
  switch (candidate.detectedBy) {
    case 'html5-video':
    case 'html5-audio':
      return 'html5';
    case 'network-media':
      return 'progressive';
    case 'media-source':
      return 'media-source';
    case 'blob-media':
      return 'blob';
    default:
      return 'direct';
  }
}
