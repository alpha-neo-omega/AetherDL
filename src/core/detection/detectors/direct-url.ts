/**
 * Module: core/detection/detectors (direct-url)
 * Purpose: Detect direct media URLs ending in a supported extension (PROJECT_BIBLE.md
 *          §9.2, §5.1) — from observed URLs and DOM link (`<a href>`) signals.
 * Restrictions: Depends only on the detector contract, pipeline input types, and
 *          shared/ (§9.2). No cross-detector imports, no browser globals.
 * Public API: createDirectUrlDetector.
 */
import {
  extensionToMime,
  filenameFromUrl,
  getExtension,
  isDownloadableUrl,
  isSupportedExtension,
  kindFromExtension,
} from '@shared/utils';
import type { Detector } from '@core/detection/detectors';
import type { DetectionContext, RawCandidate } from '@core/detection/pipeline';

const ID = 'direct-url';
const PRIORITY = 80;

function candidateUrls(context: DetectionContext): readonly string[] {
  const urls = new Set<string>(context.observedUrls);
  for (const signal of context.domSignals) {
    if (signal.role === 'link' && signal.href !== undefined && signal.href !== '') {
      urls.add(signal.href);
    }
  }
  return [...urls];
}

function collect(context: DetectionContext): RawCandidate[] {
  const candidates: RawCandidate[] = [];
  for (const url of candidateUrls(context)) {
    if (!isDownloadableUrl(url)) {
      continue;
    }
    const ext = getExtension(url);
    if (ext === undefined || !isSupportedExtension(ext)) {
      continue;
    }
    const kind = kindFromExtension(ext);
    if (kind === undefined) {
      continue;
    }
    const mime = extensionToMime(ext);
    const filename = filenameFromUrl(url);
    candidates.push({
      url,
      kind,
      detectedBy: ID,
      container: ext,
      sourceKey: `url:${url}`,
      ...(mime !== undefined && { mimeType: mime }),
      ...(filename !== undefined && { filename }),
    });
  }
  return candidates;
}

export function createDirectUrlDetector(): Detector {
  return {
    id: ID,
    name: 'Direct Media URL',
    priority: PRIORITY,
    enabled: true,
    canDetect: (context) =>
      context.observedUrls.length > 0 ||
      context.domSignals.some(
        (signal) => signal.role === 'link' && signal.href !== undefined && signal.href !== '',
      ),
    detect: (context) => Promise.resolve(collect(context)),
    metadata: () => ({
      id: ID,
      name: 'Direct Media URL',
      priority: PRIORITY,
      enabled: true,
      supportedKinds: ['video', 'audio'],
    }),
  };
}
