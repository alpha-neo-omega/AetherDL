/**
 * Module: core/download (validation)
 * Purpose: Gate what may be downloaded (PROJECT_BIBLE.md §5, §6, §13.5, §10).
 *          Progressive / direct / HTML5 file resources over http(s) are downloadable.
 *          Non-encrypted HLS/DASH manifests are downloadable ONLY when the caller
 *          passes a build that can assemble them (§10.6) — the manager passes
 *          `allowStreams` when a stream-delivery adapter is wired in, so a build
 *          without one behaves exactly as before.
 *          DRM/encrypted, blob-backed and MediaSource media stay REFUSED — never
 *          downloaded (§6). Encryption is refused again inside assembly itself.
 * Restrictions: Domain layer — pure. Browser-permission checks are runtime (the
 *          adapter surfaces PermissionDeniedError at start time).
 * Public API: FORBIDDEN_DELIVERY, STREAM_DELIVERY, ValidateOptions,
 *          validateDownloadable.
 */
import { err, ok, type Result } from '@shared/result';
import type { DeliveryType, MediaItem } from '@shared/types';
import { isDownloadableUrl, manifestTypeFromUrl } from '@shared/utils';
import { DownloadValidationError } from '@core/download/errors';

/**
 * Delivery types that MUST NOT be downloaded, with or without assembly. A blob URL
 * cannot be re-read from another context and a MediaSource has no addressable bytes;
 * neither is a refusal that assembly could lift (§5.4, §13).
 */
export const FORBIDDEN_DELIVERY: ReadonlySet<DeliveryType> = new Set<DeliveryType>([
  'blob',
  'media-source',
]);

/** Delivery types that need assembly, and are refused without it (§10.6). */
export const STREAM_DELIVERY: ReadonlySet<DeliveryType> = new Set<DeliveryType>(['hls', 'dash']);

export interface ValidateOptions {
  /**
   * Whether the caller can assemble a manifest into a file. Default `false`: a
   * caller that cannot assemble must keep refusing streams rather than handing a
   * playlist to the browser's download manager, which would save the text file.
   */
  readonly allowStreams?: boolean;
}

function reject(
  message: string,
  code: string,
  item: MediaItem,
): Result<never, DownloadValidationError> {
  return err(
    new DownloadValidationError(message, {
      code,
      messageKey: 'error.download.validation',
      context: { url: item.url, delivery: item.delivery ?? null, status: item.status },
    }),
  );
}

export function validateDownloadable(
  item: MediaItem,
  options: ValidateOptions = {},
): Result<MediaItem, DownloadValidationError> {
  const allowStreams = options.allowStreams === true;
  // DRM/blob/MediaSource/encrypted media is classified unsupported upstream (§6.3).
  if (item.status !== 'supported') {
    return reject(
      'Media is not supported for download (DRM/blob/protected)',
      'download-unsupported-status',
      item,
    );
  }
  // Blob/MediaSource delivery has no addressable bytes to save (§5.4).
  if (item.delivery !== undefined && FORBIDDEN_DELIVERY.has(item.delivery)) {
    return reject(
      `Delivery type "${item.delivery}" is not downloadable`,
      'download-forbidden-delivery',
      item,
    );
  }
  // Streams need assembly. The check covers BOTH the declared delivery type and the
  // URL's own extension, because `delivery` is optional and an HLS item with it
  // unset would otherwise be handed to the browser, which would save the playlist
  // text instead of the video (§6, §10.6).
  const isStream =
    (item.delivery !== undefined && STREAM_DELIVERY.has(item.delivery)) ||
    manifestTypeFromUrl(item.url) !== undefined;
  if (isStream && !allowStreams) {
    return reject(
      'Stream manifests cannot be downloaded in this build',
      'download-manifest-url',
      item,
    );
  }
  // Only well-formed http(s) URLs (§13.5); blob: fails this by design.
  if (!isDownloadableUrl(item.url)) {
    return reject('Media URL is not a downloadable http(s) URL', 'download-bad-url', item);
  }
  return ok(item);
}
