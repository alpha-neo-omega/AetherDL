/**
 * Module: platform/http
 * Purpose: Read-only HTTP access for non-DRM stream assembly (PROJECT_BIBLE.md
 *          §10.6). The ONLY contract in the codebase through which the extension's
 *          own code may reach the network; every other network byte belongs to the
 *          browser's download manager (§10.8).
 * Restrictions: Platform layer — depends only on shared/. Reads only: no method other
 *          than GET, no body, no credentials, no cookies. `http(s)` URLs only. The
 *          CALLER is responsible for holding the host permission for the origin it
 *          asks for (§13.7); this contract never requests one.
 * Dependencies: none.
 * Public API: HttpByteRange, HttpRequestOptions, HttpResponse, HttpClient.
 */

/** Inclusive byte range, mapped to a `Range: bytes=first-last` request header. */
export interface HttpByteRange {
  readonly first: number;
  /** Omitted means "to the end of the resource". */
  readonly last?: number;
}

export interface HttpRequestOptions {
  readonly range?: HttpByteRange;
  /** Caller-owned cancellation; composed with the client's own timeout. */
  readonly signal?: AbortSignal;
  /** Per-request budget in ms. Omitted uses the client default. */
  readonly timeoutMs?: number;
  /** Hard ceiling on the bytes this response may produce. */
  readonly maxBytes?: number;
  /**
   * Stop reading at `maxBytes` and return what arrived, instead of refusing an
   * oversized response.
   *
   * For identifying a resource from its first bytes (§9.1, ADR-012). A `Range` header
   * would be the obvious way to ask for a prefix, but `Range` is not CORS-safelisted:
   * cross-origin it forces a preflight that many hosts do not answer, and a host that
   * ignores the range answers `200` with the whole body, which this client refuses.
   * A plain GET that stops reading works on strictly more hosts.
   *
   * ASSEMBLY MUST NOT SET THIS. A truncated segment written into an output file would
   * be silent corruption; the download path wants the refusal (§10.6).
   */
  readonly truncate?: boolean;
}

export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  /** Response headers with lowercased names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly bytes: Uint8Array;
  /** The URL the response actually came from, after any redirect. */
  readonly url: string;
}

export interface HttpClient {
  /** GET a resource, optionally a byte range of it. */
  get(url: string, options?: HttpRequestOptions): Promise<HttpResponse>;
  /** GET a resource and decode it as UTF-8 text (manifests). */
  getText(url: string, options?: HttpRequestOptions): Promise<string>;
}
