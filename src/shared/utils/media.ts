/**
 * Module: shared/utils (media format helpers)
 * Purpose: Pure, generic helpers for supported media formats (PROJECT_BIBLE.md §5.1)
 *          — extension/MIME/kind mapping and filename extraction. Placed in shared/
 *          so detectors may use them while depending only on the detector contract
 *          and shared/ (§9.2).
 * Restrictions: Leaf layer — no internal deps beyond sibling shared types, no side
 *          effects (§8.16). No DRM/stream handling (Phase 4).
 * Dependencies: shared/types (MediaKind).
 * Public API: SUPPORTED_MEDIA_EXTENSIONS, getExtension, isSupportedExtension,
 *          extensionToMime, isSupportedMime, kindFromExtension, kindFromMime,
 *          filenameFromUrl.
 */
import type { MediaKind } from '@shared/types';

/** Supported video containers → canonical MIME (PROJECT_BIBLE.md §5.1). */
const VIDEO_EXTENSIONS: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
};

/** Supported audio containers → canonical MIME (PROJECT_BIBLE.md §5.1). */
const AUDIO_EXTENSIONS: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
};

const EXTENSION_TO_MIME: Readonly<Record<string, string>> = {
  ...VIDEO_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
};

/**
 * Closed allowlist of supported MIME types (§5.1): the canonical container MIMEs
 * plus documented alternates. A prefix check (`video/*`/`audio/*`) is intentionally
 * NOT used — it would wrongly admit streaming/unsupported types such as
 * `application/x-mpegurl`, `audio/x-mpegurl` (HLS) or `video/mp2t` (MPEG-TS), which
 * Phase 3 must not surface (§6, §5.5).
 */
const SUPPORTED_MIMES: ReadonlySet<string> = new Set<string>([
  ...Object.values(EXTENSION_TO_MIME),
  'audio/x-m4a',
  'audio/x-wav',
]);

/** All supported container extensions (lowercase, no dot). */
export const SUPPORTED_MEDIA_EXTENSIONS: readonly string[] = Object.keys(EXTENSION_TO_MIME);

/** Normalize a raw MIME to its lowercase type (drops parameters like `; codecs=`). */
function normalizeMime(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * Extract the lowercase file extension from a URL or path (no dot), ignoring query
 * and fragment. Returns `undefined` when there is no meaningful extension.
 */
export function getExtension(urlOrPath: string): string | undefined {
  const withoutQuery = urlOrPath.split(/[?#]/)[0] ?? '';
  const lastSegment = withoutQuery.split('/').pop() ?? '';
  const dot = lastSegment.lastIndexOf('.');
  if (dot <= 0 || dot === lastSegment.length - 1) {
    return undefined;
  }
  return lastSegment.slice(dot + 1).toLowerCase();
}

/** Whether an extension is a supported media container (§5.1). */
export function isSupportedExtension(ext: string): boolean {
  return ext.toLowerCase() in EXTENSION_TO_MIME;
}

/** Canonical MIME for a supported extension, or `undefined`. */
export function extensionToMime(ext: string): string | undefined {
  return EXTENSION_TO_MIME[ext.toLowerCase()];
}

/** Whether a MIME is an allowlisted supported container (§5.1); excludes streams. */
export function isSupportedMime(mime: string): boolean {
  const normalized = normalizeMime(mime);
  return normalized !== '' && SUPPORTED_MIMES.has(normalized);
}

/** Derive the media kind from an extension, or `undefined` when unsupported. */
export function kindFromExtension(ext: string): MediaKind | undefined {
  const lower = ext.toLowerCase();
  if (lower in VIDEO_EXTENSIONS) {
    return 'video';
  }
  if (lower in AUDIO_EXTENSIONS) {
    return 'audio';
  }
  return undefined;
}

/** Derive the media kind from a MIME, or `undefined` when not audio/video. */
export function kindFromMime(mime: string): MediaKind | undefined {
  const normalized = normalizeMime(mime);
  if (normalized.startsWith('video/')) {
    return 'video';
  }
  if (normalized.startsWith('audio/')) {
    return 'audio';
  }
  return undefined;
}

/** Adaptive-streaming manifest type (§5.5). */
export type ManifestType = 'hls' | 'dash';

/** HLS/DASH manifest extensions → type. Recognition only (no fetch/parse, §6). */
const MANIFEST_EXTENSION_TO_TYPE: Readonly<Record<string, ManifestType>> = {
  m3u8: 'hls',
  m3u: 'hls',
  mpd: 'dash',
};

const HLS_MIMES: ReadonlySet<string> = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
]);

/** Recognize a manifest type from a URL's extension, or `undefined`. */
export function manifestTypeFromExtension(ext: string): ManifestType | undefined {
  return MANIFEST_EXTENSION_TO_TYPE[ext.toLowerCase()];
}

/** Recognize a manifest type from a MIME, or `undefined`. */
export function manifestTypeFromMime(mime: string): ManifestType | undefined {
  const normalized = normalizeMime(mime);
  if (HLS_MIMES.has(normalized)) {
    return 'hls';
  }
  if (normalized === 'application/dash+xml') {
    return 'dash';
  }
  return undefined;
}

/** Recognize a manifest type from a URL (extension), or `undefined`. */
export function manifestTypeFromUrl(url: string): ManifestType | undefined {
  const ext = getExtension(url);
  return ext !== undefined ? manifestTypeFromExtension(ext) : undefined;
}

/** Best-effort decoded filename from a URL, or `undefined`. */
export function filenameFromUrl(url: string): string | undefined {
  const withoutQuery = url.split(/[?#]/)[0] ?? '';
  const lastSegment = withoutQuery.split('/').pop() ?? '';
  if (lastSegment === '') {
    return undefined;
  }
  try {
    return decodeURIComponent(lastSegment);
  } catch {
    return lastSegment;
  }
}
