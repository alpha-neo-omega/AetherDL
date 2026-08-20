/**
 * Module: shared/result (stream refusal vocabulary)
 * Purpose: One place that says what a stream-assembly error code MEANS — which
 *          sentence the user should read, whether another attempt could ever help,
 *          and whether the refusal is about protected content (PROJECT_BIBLE.md
 *          §20.2, §20.5, §10.6).
 * Restrictions: Leaf layer — pure mapping, no dependencies. It exists in `shared`
 *          because BOTH sides of the offscreen boundary need it: the domain raises
 *          the error, and the platform client rebuilds it from the wire, where a
 *          message only carries a code. Without this, every Chromium stream refusal
 *          reached the user as a generic messaging failure.
 * Public API: STREAM_ERROR_CODE_PREFIXES, isStreamErrorCode, isProtectedStreamCode,
 *          streamMessageKeyFor, streamRetryableFor.
 */

/** Codes produced by the assembly path and its HTTP client. */
export const STREAM_ERROR_CODE_PREFIXES: readonly string[] = ['stream-', 'http-'];

export function isStreamErrorCode(code: string): boolean {
  return STREAM_ERROR_CODE_PREFIXES.some((prefix) => code.startsWith(prefix));
}

/** Encryption: refused, never retried, and described as protected media (§6). */
export function isProtectedStreamCode(code: string): boolean {
  return code.endsWith('-encrypted');
}

/**
 * The message key a refusal should be shown with. A live stream is not a connection
 * problem and an encrypted one is not a transport failure; each gets its own sentence.
 */
export function streamMessageKeyFor(code: string): string {
  if (isProtectedStreamCode(code)) {
    return 'error.drm';
  }
  if (code.endsWith('-live') || code === 'stream-dash-dynamic') {
    return 'error.download.stream.live';
  }
  if (code.endsWith('-too-large') || code.endsWith('-too-many')) {
    return 'error.download.stream.tooLarge';
  }
  if (
    code.endsWith('-separate-audio') ||
    // Everything the demuxer, the writer and the muxer can refuse is about the
    // TRACKS in the stream — a rendition with no readable track, bytes that are not a
    // transport stream, a missing parameter set. They read as track problems, not as
    // network problems, on both sides of the offscreen boundary (§20.5).
    code.startsWith('stream-ts-') ||
    code.startsWith('stream-mp4-') ||
    code.startsWith('stream-mux-')
  ) {
    return 'error.download.stream.tracks';
  }
  if (
    code === 'stream-manifest-fetch-failed' ||
    code === 'stream-segment-failed' ||
    code.startsWith('http-')
  ) {
    return 'error.network';
  }
  return 'error.download.stream';
}

/**
 * Whether another attempt could plausibly succeed. Transport failures can; a refusal
 * about what the stream IS never can, and retrying one only wastes the user's time.
 */
export function streamRetryableFor(code: string): boolean {
  if (code === 'stream-manifest-fetch-failed' || code === 'stream-segment-failed') {
    return true;
  }
  return code === 'http-timeout' || code === 'http-network-failed';
}
