/**
 * Module: core/detection/probe
 * Purpose: Identify what a URL the page fetched actually IS, by reading its first
 *          bytes (PROJECT_BIBLE.md §9.1, §14.3, ADR-012). Contract only;
 *          implementation in ./probe.
 *
 *          A modern player never puts its playlist in the DOM — it fetches it with
 *          script and hands the bytes to MediaSource, leaving only a `blob:` URL
 *          behind. Worse, hosts serve those playlists under names that are lies: a
 *          `.txt` served as `text/plain` whose body is `#EXTM3U`, with MPEG-TS
 *          segments named `.css`. Neither the URL nor the `Content-Type` can be
 *          trusted, so this reads the bytes and reports the truth.
 *
 * Restrictions: Domain layer. All network access goes through the injected
 *          {@link HttpClient} port — the single door in `platform/http` (§8.4, §13.10)
 *          — as a bounded, credential-free `GET` of a few hundred bytes. It probes
 *          ONLY URLs the page itself already loaded, never a URL it invented, and
 *          never a key: encryption is refused by the parsers downstream and nothing
 *          here decrypts anything (§6, ADR-005).
 * Dependencies: platform/http (type only), core/detection/pipeline (NetworkResource).
 * Public API: PROBE_MAX_PER_RUN, PROBE_MAX_RESOURCE_BYTES, PROBE_MAX_MEDIA_RESULTS,
 *          ObservedResource, ResourceProbeOptions, ResourceProbe.
 */
import type { HttpClient } from '@platform/http';
import type { NetworkResource } from '@core/detection/pipeline';

/**
 * How many URLs one detection run may look at.
 *
 * A page loads hundreds of resources; a playlist is one of them. The cap is what keeps
 * "identify the stream" from becoming "crawl the page" (§12.6, §10.9).
 */
export const PROBE_MAX_PER_RUN = 8;

/**
 * Resources larger than this are not manifests.
 *
 * A playlist is kilobytes. Skipping the big ones keeps the probe away from the
 * segments themselves, which the assembler sniffs later from bytes it has already
 * fetched for the download the user asked for.
 */
export const PROBE_MAX_RESOURCE_BYTES = 2 * 1024 * 1024;

/**
 * How many non-manifest media results one page may contribute.
 *
 * A stream is hundreds of segments. Reporting each identified segment as its own
 * downloadable item would bury the one thing the user wants — the stream — under its
 * own parts. When a manifest is found, the segments are suppressed entirely; when none
 * is, a couple of standalone media files are still worth surfacing (§4.2, §11.6).
 */
export const PROBE_MAX_MEDIA_RESULTS = 3;

/**
 * A resource the page fetched, as the content script observed it through the
 * Resource Timing API.
 *
 * `initiatorType` is the load-bearing field: a disguised playlist fools every check
 * that reads its name, but it cannot hide that a script fetched it rather than the
 * browser loading it as a stylesheet or an image.
 */
export interface ObservedResource {
  readonly url: string;
  /** Resource Timing `initiatorType`: `xmlhttprequest`, `fetch`, `link`, `img`, … */
  readonly initiatorType?: string;
  /** Bytes over the wire, when the timeline knew them (0 for cross-origin without TAO). */
  readonly sizeBytes?: number;
}

export interface ResourceProbeOptions {
  readonly http: HttpClient;
  /** Overrides {@link PROBE_MAX_PER_RUN}. */
  readonly maxPerRun?: number;
  /** Per-request budget; a probe that is slow is not worth waiting for. */
  readonly timeoutMs?: number;
  /** Bounds the memory of the "already identified" cache. */
  readonly maxCacheEntries?: number;
}

export interface ResourceProbe {
  /**
   * Identify whichever observed resources are worth identifying, and report them as
   * network resources with the MIME their BYTES imply — not the one their server
   * claimed. Never rejects: a probe that fails contributes nothing and detection
   * proceeds on what the DOM gave it.
   */
  identify(
    resources: readonly ObservedResource[],
    signal?: AbortSignal,
  ): Promise<readonly NetworkResource[]>;
  /** Drop what has been identified so far (navigation, or a memory bound). */
  forget(): void;
}
