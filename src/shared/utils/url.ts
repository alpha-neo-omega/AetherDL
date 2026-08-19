/**
 * Module: shared/utils (URL helpers)
 * Purpose: Safe URL validation and parsing (PROJECT_BIBLE.md §13.5). Used by the
 *          tabs service to filter navigations and, in later phases, by detection
 *          and downloads to validate media URLs.
 * Responsibilities: Parse, validate scheme, and extract host — all pure.
 * Restrictions: Leaf layer — no internal dependencies, no side effects (§8.16).
 * Dependencies: none (uses the standard URL API).
 * Public API: parseUrl, isDownloadableUrl, isBlobUrl, getHost, normalizeUrl.
 */

/** Schemes eligible for download/navigation contexts (§13.5). */
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/** Parse a URL, returning `undefined` for malformed input (never throws). */
export function parseUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/** Whether a URL is a well-formed http(s) URL eligible for downloading (§13.5). */
export function isDownloadableUrl(raw: string): boolean {
  const url = parseUrl(raw);
  return url !== undefined && ALLOWED_PROTOCOLS.has(url.protocol);
}

/** Whether a URL is a page-scoped `blob:` URL (§5.4 — conditional support). */
export function isBlobUrl(raw: string): boolean {
  return raw.startsWith('blob:');
}

/** Extract the host of a URL, or `undefined` when malformed. */
export function getHost(raw: string): string | undefined {
  return parseUrl(raw)?.host;
}

/**
 * Canonicalize a URL for stable identity comparison (§9.5 dedupe): lowercase host,
 * drop the fragment, and remove default ports. Query is preserved (it can select a
 * distinct resource). Returns `undefined` for malformed input. Works for `blob:`
 * URLs too (host is empty; the opaque body is preserved as the identity).
 */
export function normalizeUrl(raw: string): string | undefined {
  const url = parseUrl(raw);
  if (url === undefined) {
    return undefined;
  }
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443')
  ) {
    url.port = '';
  }
  return url.toString();
}
