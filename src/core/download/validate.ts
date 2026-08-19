/**
 * Module: core/download (validation)
 * Purpose: Gate what may be downloaded (PROJECT_BIBLE.md §5, §6, §13.5, §10). Only
 *          progressive / direct / HTML5 file resources over http(s) are downloadable.
 *          DRM/encrypted, blob-backed, MediaSource, and HLS/DASH stream media are
 *          REFUSED — never downloaded (§6, §10.6 assembly is out of Phase 5 scope).
 * Restrictions: Domain layer — pure. Browser-permission checks are runtime (the
 *          adapter surfaces PermissionDeniedError at start time).
 * Public API: FORBIDDEN_DELIVERY, validateDownloadable.
 */
import { err, ok, type Result } from '@shared/result';
import type { DeliveryType, MediaItem } from '@shared/types';
import { isDownloadableUrl, manifestTypeFromUrl } from '@shared/utils';
import { DownloadValidationError } from '@core/download/errors';

/** Delivery types that MUST NOT be downloaded via the native Downloads API. */
export const FORBIDDEN_DELIVERY: ReadonlySet<DeliveryType> = new Set<DeliveryType>([
  'hls',
  'dash',
  'blob',
  'media-source',
]);

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

export function validateDownloadable(item: MediaItem): Result<MediaItem, DownloadValidationError> {
  // DRM/blob/MediaSource/encrypted media is classified unsupported upstream (§6.3).
  if (item.status !== 'supported') {
    return reject(
      'Media is not supported for download (DRM/blob/protected)',
      'download-unsupported-status',
      item,
    );
  }
  // Streaming/blob delivery cannot be downloaded as a single file this phase (§10.6).
  if (item.delivery !== undefined && FORBIDDEN_DELIVERY.has(item.delivery)) {
    return reject(
      `Delivery type "${item.delivery}" is not downloadable`,
      'download-forbidden-delivery',
      item,
    );
  }
  // Defense in depth: the forbidden-delivery gate above keys on the OPTIONAL
  // `delivery` field, so an HLS/DASH item with `delivery` unset would slip through.
  // Reject any manifest URL (m3u8/m3u/mpd) by extension regardless of delivery (§6).
  if (manifestTypeFromUrl(item.url) !== undefined) {
    return reject('Manifest/stream URLs are not downloadable', 'download-manifest-url', item);
  }
  // Only well-formed http(s) URLs (§13.5); blob: fails this by design.
  if (!isDownloadableUrl(item.url)) {
    return reject('Media URL is not a downloadable http(s) URL', 'download-bad-url', item);
  }
  return ok(item);
}
