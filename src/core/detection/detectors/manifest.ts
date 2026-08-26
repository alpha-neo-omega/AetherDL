/**
 * Module: core/detection/detectors (manifest: HLS + DASH)
 * Purpose: RECOGNIZE and CLASSIFY adaptive-streaming manifest URLs — HLS master and
 *          media playlists (.m3u8) and MPEG-DASH manifests (.mpd) (PROJECT_BIBLE.md
 *          §5.5, §9.2). Recognition/classification ONLY: it does NOT fetch, parse,
 *          download, or assemble manifests/segments (Phase 5 / §10.6).
 * Restrictions: Depends only on the detector contract, pipeline input types, and
 *          shared/ (§9.2). No cross-detector imports, no browser globals, no fetch.
 * Public API: createHlsManifestDetector, createDashManifestDetector.
 *
 * Both detectors share one parameterized factory (identical logic, differing only by
 * manifest type) to avoid duplication while exposing the two Bible §9.2 ids.
 */
import {
  isSupportedExtension,
  getExtension,
  manifestTypeFromMime,
  manifestTypeFromUrl,
  type ManifestType,
} from '@shared/utils';
import type { Detector } from '@core/detection/detectors';
import type { DetectionContext, RawCandidate } from '@core/detection/pipeline';

interface ManifestSpec {
  readonly type: ManifestType;
  readonly id: string;
  readonly name: string;
  readonly priority: number;
}

function resolveType(url: string, mime: string | undefined): ManifestType | undefined {
  return manifestTypeFromUrl(url) ?? (mime !== undefined ? manifestTypeFromMime(mime) : undefined);
}

function collect(context: DetectionContext, spec: ManifestSpec): RawCandidate[] {
  const seen = new Set<string>();
  const candidates: RawCandidate[] = [];

  const consider = (
    url: string | undefined,
    mime: string | undefined,
    encrypted?: boolean,
  ): void => {
    if (url === undefined || url === '' || seen.has(url)) {
      return;
    }
    if (resolveType(url, mime) !== spec.type) {
      return;
    }
    seen.add(url);
    // Only report a container when the URL's own extension really is a manifest
    // extension. A host that serves its playlist as `.txt` would otherwise have the
    // extension it invented shown to the user and used to name the file (§2.8, §10.7).
    const ext = getExtension(url);
    const honestExtension = ext !== undefined && manifestTypeFromUrl(url) !== undefined;
    candidates.push({
      url,
      kind: 'stream',
      detectedBy: spec.id,
      delivery: spec.type,
      sourceKey: `${spec.type}:${url}`,
      ...(honestExtension && { container: ext }),
      // With no usable name in the URL, the page's own title is the honest label —
      // better than showing the user "playlist.txt".
      ...(!honestExtension &&
        titleFromPage(context.documentTitle) !== undefined && {
          title: titleFromPage(context.documentTitle) as string,
        }),
      ...(mime !== undefined && { mimeType: mime }),
      ...(encrypted === true && { encrypted: true }),
    });
  };

  for (const url of context.observedUrls) {
    consider(url, undefined);
  }
  for (const resource of context.networkResources ?? []) {
    consider(resource.url, resource.mimeType);
  }
  for (const signal of context.domSignals) {
    if (signal.role === 'link') {
      consider(signal.href, signal.type, signal.encrypted);
    } else {
      consider(signal.currentSrc ?? signal.src, signal.type, signal.encrypted);
    }
  }
  return candidates;
}

/**
 * The page's title, without a trailing media extension.
 *
 * A host that names its playlist `.txt` often titles the page after the uploaded file —
 * "1080.mp4" — and carrying that through would label an HLS stream with a container it
 * is not, and then save it as `1080.mp4.ts`. The real extension is decided by the
 * segments' own bytes at assembly time (§10.7, §2.8).
 */
function titleFromPage(documentTitle: string | undefined): string | undefined {
  if (documentTitle === undefined || documentTitle.trim() === '') {
    return undefined;
  }
  const title = documentTitle.trim();
  const dot = title.lastIndexOf('.');
  if (dot <= 0) {
    return title;
  }
  const extension = title.slice(dot + 1).toLowerCase();
  const stripped = title.slice(0, dot).trim();
  return isSupportedExtension(extension) && stripped !== '' ? stripped : title;
}

function hasManifest(context: DetectionContext, type: ManifestType): boolean {
  if (context.observedUrls.some((url) => manifestTypeFromUrl(url) === type)) {
    return true;
  }
  if ((context.networkResources ?? []).some((r) => resolveType(r.url, r.mimeType) === type)) {
    return true;
  }
  return context.domSignals.some((signal) => {
    const url = signal.role === 'link' ? signal.href : (signal.currentSrc ?? signal.src);
    return url !== undefined && resolveType(url, signal.type) === type;
  });
}

function createManifestDetector(spec: ManifestSpec): Detector {
  return {
    id: spec.id,
    name: spec.name,
    priority: spec.priority,
    enabled: true,
    canDetect: (context) => hasManifest(context, spec.type),
    detect: (context) => Promise.resolve(collect(context, spec)),
    metadata: () => ({
      id: spec.id,
      name: spec.name,
      priority: spec.priority,
      enabled: true,
      supportedKinds: ['stream'],
    }),
  };
}

export function createHlsManifestDetector(): Detector {
  return createManifestDetector({
    type: 'hls',
    id: 'hls-manifest',
    name: 'HLS Manifest',
    priority: 70,
  });
}

export function createDashManifestDetector(): Detector {
  return createManifestDetector({
    type: 'dash',
    id: 'dash-manifest',
    name: 'DASH Manifest',
    priority: 70,
  });
}
