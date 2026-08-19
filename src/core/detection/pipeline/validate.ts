/**
 * Module: core/detection/pipeline (validation)
 * Purpose: Validate raw candidates before they become MediaItems (PROJECT_BIBLE.md
 *          §13.5, §9.3, §5.5). Rejects empty/malformed URLs, unsupported protocols,
 *          unsupported media types, and malformed manifest URLs. Recognized (well-
 *          formed http(s)) HLS/DASH manifests are accepted for classification;
 *          encrypted (DRM) media is NOT rejected here — it is classified as
 *          unsupported in the build stage (§6.3/§9.1), i.e. reported but refused.
 * Restrictions: Domain layer — pure. No fetch/parse of manifests (§6).
 * Public API: validateCandidate.
 */
import { err, ok, type Result } from '@shared/result';
import {
  getExtension,
  isBlobUrl,
  isDownloadableUrl,
  isSupportedExtension,
  isSupportedMime,
  manifestTypeFromMime,
  manifestTypeFromUrl,
  parseUrl,
} from '@shared/utils';
import { ManifestError, UnsupportedMedia, ValidationFailure } from '@core/detection/errors';
import type { RawCandidate } from '@core/detection/pipeline';

type ValidationError = ValidationFailure | UnsupportedMedia | ManifestError;

function isManifestCandidate(candidate: RawCandidate, url: string): boolean {
  if (manifestTypeFromUrl(url) !== undefined) {
    return true;
  }
  if (candidate.mimeType !== undefined && manifestTypeFromMime(candidate.mimeType) !== undefined) {
    return true;
  }
  return candidate.delivery === 'hls' || candidate.delivery === 'dash';
}

export function validateCandidate(candidate: RawCandidate): Result<RawCandidate, ValidationError> {
  const url = candidate.url.trim();

  if (url === '') {
    return err(
      new ValidationFailure('Empty media URL', {
        code: 'detection-empty-url',
        messageKey: 'error.detection.emptyUrl',
      }),
    );
  }

  if (isBlobUrl(url)) {
    // Blob media is best-effort (§5.4): accept only when the kind is known or a
    // supported MIME is present; never reconstruct the blob.
    const mimeSupported = candidate.mimeType !== undefined && isSupportedMime(candidate.mimeType);
    if (!mimeSupported && candidate.kind !== 'video' && candidate.kind !== 'audio') {
      return err(
        new UnsupportedMedia(`Unclassifiable blob media: ${url}`, {
          code: 'detection-blob-unclassified',
          messageKey: 'error.detection.unsupported',
          context: { url },
        }),
      );
    }
    return ok(candidate);
  }

  const manifest = isManifestCandidate(candidate, url);

  const parsed = parseUrl(url);
  if (parsed === undefined) {
    return err(
      manifest
        ? new ManifestError(`Malformed manifest URL: ${url}`, {
            code: 'detection-manifest-malformed',
            messageKey: 'error.detection.manifest',
            context: { url },
          })
        : new ValidationFailure(`Malformed URL: ${url}`, {
            code: 'detection-malformed-url',
            messageKey: 'error.detection.malformedUrl',
            context: { url },
          }),
    );
  }

  if (!isDownloadableUrl(url)) {
    return err(
      manifest
        ? new ManifestError(`Manifest uses an unsupported protocol: ${parsed.protocol}`, {
            code: 'detection-manifest-protocol',
            messageKey: 'error.detection.manifest',
            context: { protocol: parsed.protocol },
          })
        : new ValidationFailure(`Unsupported protocol: ${parsed.protocol}`, {
            code: 'detection-bad-protocol',
            messageKey: 'error.detection.protocol',
            context: { protocol: parsed.protocol },
          }),
    );
  }

  // A well-formed http(s) manifest is accepted for recognition/classification (§5.5).
  if (manifest) {
    return ok(candidate);
  }

  const ext = candidate.container ?? getExtension(url);
  const mimeSupported = candidate.mimeType !== undefined && isSupportedMime(candidate.mimeType);
  const extSupported = ext !== undefined && isSupportedExtension(ext);
  if (!mimeSupported && !extSupported) {
    return err(
      new UnsupportedMedia(`Unsupported media type for ${url}`, {
        code: 'detection-unsupported-type',
        messageKey: 'error.detection.unsupported',
        context: { url },
      }),
    );
  }

  return ok(candidate);
}
