/**
 * Module: core/detection/detectors (network-media)
 * Purpose: Detect media resources observed over the browser's networking
 *          (PROJECT_BIBLE.md §12.6). Observation only — consumes the structured
 *          NetworkResource observations the platform network observer surfaces;
 *          never intercepts encrypted traffic or bypasses browser security.
 * Restrictions: Depends only on the detector contract, pipeline input types, and
 *          shared/ (§9.2). No cross-detector imports, no browser globals, no fetch.
 * Public API: createNetworkMediaDetector.
 */
import {
  getExtension,
  isSupportedExtension,
  isSupportedMime,
  kindFromExtension,
  kindFromMime,
  manifestTypeFromMime,
  manifestTypeFromUrl,
  filenameFromUrl,
} from '@shared/utils';
import type { MediaKind } from '@shared/types';
import type { Detector } from '@core/detection/detectors';
import type { NetworkResource, RawCandidate } from '@core/detection/pipeline';

const ID = 'network-media';
const PRIORITY = 75;

function isManifest(resource: NetworkResource): boolean {
  return (
    manifestTypeFromUrl(resource.url) !== undefined ||
    (resource.mimeType !== undefined && manifestTypeFromMime(resource.mimeType) !== undefined)
  );
}

function toCandidate(resource: NetworkResource): RawCandidate | undefined {
  // Manifests are recognized by the dedicated manifest detectors, not here.
  if (isManifest(resource)) {
    return undefined;
  }
  const ext = getExtension(resource.url);
  const mimeSupported = resource.mimeType !== undefined && isSupportedMime(resource.mimeType);
  const extSupported = ext !== undefined && isSupportedExtension(ext);
  if (!mimeSupported && !extSupported) {
    return undefined;
  }
  let kind: MediaKind | undefined;
  if (resource.mimeType !== undefined) {
    kind = kindFromMime(resource.mimeType);
  }
  if (kind === undefined && ext !== undefined) {
    kind = kindFromExtension(ext);
  }
  if (kind === undefined) {
    return undefined;
  }
  const filename = filenameFromUrl(resource.url);
  return {
    url: resource.url,
    kind,
    detectedBy: ID,
    delivery: 'progressive',
    // A network response confirming a media resource is high-confidence.
    confidence: 0.9,
    sourceKey: `net:${resource.url}`,
    ...(ext !== undefined && { container: ext }),
    ...(resource.mimeType !== undefined && { mimeType: resource.mimeType }),
    ...(resource.sizeBytes !== undefined && { sizeBytes: resource.sizeBytes }),
    ...(filename !== undefined && { filename }),
  };
}

export function createNetworkMediaDetector(): Detector {
  return {
    id: ID,
    name: 'Network Media Resource',
    priority: PRIORITY,
    enabled: true,
    canDetect: (context) => (context.networkResources?.length ?? 0) > 0,
    detect: (context) =>
      Promise.resolve(
        (context.networkResources ?? [])
          .map(toCandidate)
          .filter((candidate): candidate is RawCandidate => candidate !== undefined),
      ),
    metadata: () => ({
      id: ID,
      name: 'Network Media Resource',
      priority: PRIORITY,
      enabled: true,
      supportedKinds: ['video', 'audio'],
    }),
  };
}
