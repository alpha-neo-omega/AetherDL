/**
 * Module: platform/objecturl
 * Purpose: Create a short-lived `blob:` URL for bytes the extension assembled itself,
 *          so the browser's own download manager performs the write (PROJECT_BIBLE.md
 *          §10.6, §10.8). Implementation in ./service.
 * Restrictions: Platform layer — depends only on shared/. The URL is extension-origin
 *          and local; nothing is uploaded and no remote endpoint is involved (§14.3).
 *          Every handle MUST be released, or the bytes stay resident (§8.9, §12.1).
 * Dependencies: none.
 * Public API: ObjectUrlHandle, ObjectUrlAdapter.
 */
export interface ObjectUrlHandle {
  readonly url: string;
  readonly byteLength: number;
  /** Revoke the URL and drop the bytes. Idempotent. */
  release(): void;
}

export interface ObjectUrlAdapter {
  /** Whether this context can create object URLs at all (a Chromium MV3 service
   *  worker cannot; an extension page and a Firefox event page can). */
  readonly supported: boolean;
  /** Build one blob from the parts, in order, and return a URL for it. */
  create(parts: readonly Uint8Array[], mimeType: string): ObjectUrlHandle;
}
