/**
 * Module: core/detection/probe (implementation)
 * Purpose: Read the first bytes of resources a page fetched and report what they are
 *          (PROJECT_BIBLE.md §9.1, §14.3, ADR-012).
 * Restrictions: Domain layer — no I/O of its own; every request goes through the
 *          injected {@link HttpClient} port. Bounded on every axis: how many URLs per
 *          run, how many bytes per URL, how long to wait, how much to remember. It
 *          reads; it never writes, follows a key, or decrypts (§6, ADR-005).
 * Dependencies: shared/utils (sniffing, URL typing), platform/http (type only),
 *          core/detection/pipeline (NetworkResource), core/detection/probe (contract).
 * Public API: createResourceProbe.
 */
import {
  manifestTypeFromUrl,
  sniffFormat,
  sniffHlsRole,
  SNIFF_PREFIX_BYTES,
  type HlsPlaylistRole,
  type SniffedFormat,
} from '@shared/utils';
import type { NetworkResource } from '@core/detection/pipeline';
import {
  PROBE_MAX_MEDIA_RESULTS,
  PROBE_MAX_PER_RUN,
  PROBE_MAX_RESOURCE_BYTES,
  type ObservedResource,
  type ResourceProbe,
  type ResourceProbeOptions,
} from '@core/detection/probe';

/** A probe that hangs is worthless; detection has its own budget to keep (§12.6). */
const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_MAX_CACHE = 300;

/**
 * Initiators worth looking at.
 *
 * A player fetches its playlist with script — `fetch`, or the older XHR API whose
 * Resource Timing initiator is spelled `xmlhttprequest` — or the media element loads
 * it directly. A stylesheet loaded through `<link>` really is a
 * stylesheet, whatever a disguised segment is called, so those are left alone. This
 * is what keeps the probe to a handful of requests instead of one per resource.
 */
const PROBEABLE_INITIATORS: ReadonlySet<string> = new Set([
  'xmlhttprequest',
  'fetch',
  'video',
  'audio',
  'other',
  '',
]);

const MANIFEST_MIMES: ReadonlySet<string> = new Set([
  'application/vnd.apple.mpegurl',
  'application/dash+xml',
]);

/** The MIME a sniffed format really has, replacing whatever the server claimed. */
const MIME_OF_FORMAT: Readonly<Record<SniffedFormat, string>> = {
  hls: 'application/vnd.apple.mpegurl',
  dash: 'application/dash+xml',
  'mpeg-ts': 'video/mp2t',
  mp4: 'video/mp4',
  webm: 'video/webm',
  adts: 'audio/aac',
};

/** What a probe concluded about one URL. */
interface Identified {
  readonly resource: NetworkResource;
  /** For HLS only: whether this playlist lists renditions or segments. */
  readonly role?: HlsPlaylistRole;
}

/**
 * The directory a URL lives in — origin plus everything but the last path segment.
 *
 * A master and the renditions it names are published side by side, so this is what
 * decides that two playlists belong to the same stream. Comparing whole URLs would
 * never match; comparing only origins would fold two unrelated streams on one CDN into
 * one.
 */
function groupOf(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.split('/').slice(0, -1).join('/');
    return `${parsed.origin}${path}`;
  } catch {
    return url;
  }
}

/**
 * What a URL that could not be READ still says about itself.
 *
 * Bytes beat names, and where the bytes are available this module ignores names
 * entirely — that is what it exists for. But a host that answers no cross-origin
 * request leaves no bytes to prefer: the fetch fails, and everything the page told us
 * about that resource is thrown away with it. A player fetching `.../playlist.m3u8`
 * through script is then invisible, not because it was disguised but because we were
 * not allowed to look, which is the worse failure of the two (§9.1, ADR-012).
 *
 * So an unreadable resource falls back to what its name claims, and ONLY for the two
 * manifest extensions: those are the ones a stream hangs off, and a wrong guess costs
 * a card that fails to parse rather than a silently wrong download. A disguised
 * resource — the case names cannot answer — is still dropped, exactly as before.
 */
function namedManifest(url: string): Identified | undefined {
  const type = manifestTypeFromUrl(url);
  if (type === undefined) {
    return undefined;
  }
  return {
    resource: {
      url,
      mimeType: type === 'hls' ? MIME_OF_FORMAT.hls : MIME_OF_FORMAT.dash,
    },
  };
}

function isHttpUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

/**
 * Whether this resource is worth spending a request on.
 *
 * Deliberately NOT filtered by file extension: the whole reason this module exists is
 * that a `.css` can be MPEG-TS and a `.txt` can be a playlist. Filtering by name here
 * would reintroduce the bug one layer up.
 */
function worthProbing(resource: ObservedResource): boolean {
  if (!isHttpUrl(resource.url)) {
    return false;
  }
  if (!PROBEABLE_INITIATORS.has((resource.initiatorType ?? '').toLowerCase())) {
    return false;
  }
  // A known size that is large means a segment or the media itself, not a manifest.
  // Size 0 means "cross-origin without Timing-Allow-Origin", i.e. unknown — probe it.
  return (resource.sizeBytes ?? 0) <= PROBE_MAX_RESOURCE_BYTES;
}

export function createResourceProbe(options: ResourceProbeOptions): ResourceProbe {
  const { http } = options;
  const maxPerRun = options.maxPerRun ?? PROBE_MAX_PER_RUN;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxCache = options.maxCacheEntries ?? DEFAULT_MAX_CACHE;
  /**
   * url → what it turned out to be, or `null` for "looked, and it is not media".
   * The playlist role rides along so a rendition can be recognised as belonging to a
   * master that is also on the page.
   */
  const identified = new Map<string, Identified | null>();

  const remember = (url: string, value: Identified | null): void => {
    if (identified.size >= maxCache) {
      // Oldest first: insertion order is Map's iteration order.
      const oldest = identified.keys().next().value;
      if (oldest !== undefined) {
        identified.delete(oldest);
      }
    }
    identified.set(url, value);
  };

  const probeOne = async (
    resource: ObservedResource,
    signal: AbortSignal | undefined,
  ): Promise<Identified | null> => {
    try {
      const response = await http.get(resource.url, {
        // A plain GET that stops reading, NOT a `Range` request. `Range` is not
        // CORS-safelisted: cross-origin it forces a preflight many hosts do not
        // answer, and a host that ignores it answers 200 with the whole body, which
        // the client then refuses. Truncation works on strictly more hosts and still
        // never holds more than the prefix in memory (§10.9, ADR-012).
        maxBytes: SNIFF_PREFIX_BYTES,
        truncate: true,
        timeoutMs,
        ...(signal !== undefined && { signal }),
      });
      const format = sniffFormat(response.bytes);
      if (format === undefined) {
        return null;
      }
      return {
        resource: {
          url: response.url,
          mimeType: MIME_OF_FORMAT[format],
          statusCode: response.status,
          ...(resource.sizeBytes !== undefined &&
            resource.sizeBytes > 0 && { sizeBytes: resource.sizeBytes }),
        },
        ...(format === 'hls' &&
          sniffHlsRole(response.bytes) !== undefined && {
            role: sniffHlsRole(response.bytes) as HlsPlaylistRole,
          }),
      };
    } catch {
      // A CORS rejection, a timeout, an origin that is simply gone: none of these are
      // errors the user should see. What the resource NAMED itself is all that is left,
      // and for a manifest that is still worth reporting (§20.7).
      return namedManifest(resource.url) ?? null;
    }
  };

  /**
   * What is worth reporting out of what was identified.
   *
   * A stream is its manifest, not its segments: once a playlist is found, the pieces
   * it lists are noise, and reporting each one would fill the popup with hundreds of
   * fragments of a single video (§4.2). With no manifest, a few standalone media files
   * are still worth surfacing.
   */
  const summarise = (found: readonly Identified[]): readonly NetworkResource[] => {
    const manifests = found.filter(
      (entry) =>
        entry.resource.mimeType !== undefined && MANIFEST_MIMES.has(entry.resource.mimeType),
    );
    if (manifests.length === 0) {
      return found.slice(0, PROBE_MAX_MEDIA_RESULTS).map((entry) => entry.resource);
    }
    // A player fetches the master playlist and then a rendition inside it, so a page
    // yields both. Two entries for one video is worse than one: keep the master, which
    // carries every rendition and is what the quality chooser enumerates (§10.6). Only
    // renditions that sit beside a master are dropped — a page serving a media playlist
    // on its own still has it offered.
    const mastersByGroup = new Set(
      manifests
        .filter((entry) => entry.role === 'master')
        .map((entry) => groupOf(entry.resource.url)),
    );
    const kept = manifests.filter(
      (entry) => entry.role !== 'media' || !mastersByGroup.has(groupOf(entry.resource.url)),
    );
    return (kept.length > 0 ? kept : manifests).map((entry) => entry.resource);
  };

  return {
    async identify(
      resources: readonly ObservedResource[],
      signal?: AbortSignal,
    ): Promise<readonly NetworkResource[]> {
      const found: Identified[] = [];
      const pending: ObservedResource[] = [];
      const seen = new Set<string>();

      for (const resource of resources) {
        if (seen.has(resource.url)) {
          continue;
        }
        seen.add(resource.url);
        const cached = identified.get(resource.url);
        if (cached !== undefined) {
          // Already looked at this URL — including the ones that were not media.
          if (cached !== null) {
            found.push(cached);
          }
          continue;
        }
        if (worthProbing(resource)) {
          pending.push(resource);
        }
      }

      // Sequential and capped: a detection pass must not turn into a burst of
      // requests at a host the user never asked to download from (§12.6). Within that
      // cap, a URL that already names itself a manifest goes first — a page can load
      // more candidates than the cap allows, and spending the budget on the resource
      // most likely to BE the stream beats spending it in load order.
      const ordered = [
        ...pending.filter((resource) => manifestTypeFromUrl(resource.url) !== undefined),
        ...pending.filter((resource) => manifestTypeFromUrl(resource.url) === undefined),
      ];
      for (const resource of ordered.slice(0, maxPerRun)) {
        if (signal?.aborted === true) {
          break;
        }
        const result = await probeOne(resource, signal);
        remember(resource.url, result);
        if (result !== null) {
          found.push(result);
        }
      }
      return summarise(found);
    },

    forget(): void {
      identified.clear();
    },
  };
}
