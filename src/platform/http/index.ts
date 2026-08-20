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
