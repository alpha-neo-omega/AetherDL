/**
 * Module: core/download/stream (assembly)
 * Purpose: Turn a non-encrypted HLS/DASH manifest into one contiguous byte stream
 *          (PROJECT_BIBLE.md §10.6, §5.5). Fetches the manifest, parses it, picks a
 *          rendition, fetches every segment in playlist order, and reports progress.
 * Restrictions: Domain layer — it performs NO I/O itself. All network access goes
 *          through the injected `HttpClient` port (platform/http), which the caller
 *          owns along with the host permission (§8.4, §13.7).
 *          ENCRYPTION IS A HARD REFUSAL at every step: an encrypted manifest, a
 *          protected representation, or an encrypted variant selected from a master
 *          playlist all end assembly. No key is fetched, read or stored (§6, ADR-005).
 * Dependencies: shared/result, shared/utils, platform/http (type only),
 *          core/download/stream (hls, dash).
 * Public API: STREAM_MAX_TOTAL_BYTES, STREAM_MAX_SEGMENT_BYTES, StreamKind,
 *          AssembleRequest, AssembledStream, StreamAssemblyProgress,
 *          detectStreamKind, streamOriginsFor, assembleStream.
 */
import { err, ok, type Result } from '@shared/result';
import { PlatformError } from '@shared/result/errors';
import { StreamAssemblyError } from '@core/download/errors';
import { manifestTypeFromUrl } from '@shared/utils';
import type { HttpClient } from '@platform/http';
import {
  parseDashManifest,
  type DashRepresentation,
  type DashSegment,
} from '@core/download/stream/dash';
import { parseHlsPlaylist, type HlsSegment } from '@core/download/stream/hls';

/**
 * Assembly holds the finished media in memory before handing it to the browser, so
 * the ceiling is a refusal, not a target. A stream past it is reported as too large
 * rather than being attempted and killing the worker (§12.1, §10.9).
 */
export const STREAM_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
/** One segment is never legitimately this big; a hostile server's would be. */
export const STREAM_MAX_SEGMENT_BYTES = 64 * 1024 * 1024;

export type StreamKind = 'hls' | 'dash';

export interface StreamAssemblyProgress {
  readonly segmentsDone: number;
  readonly segmentsTotal: number;
  readonly bytesReceived: number;
}

export interface AssembleRequest {
  readonly manifestUrl: string;
  readonly http: HttpClient;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: StreamAssemblyProgress) => void;
  readonly maxTotalBytes?: number;
}

export interface AssembledStream {
  readonly kind: StreamKind;
  /** Segment payloads in playlist order; the caller concatenates or streams them. */
  readonly parts: readonly Uint8Array[];
  readonly byteLength: number;
  /** Container the assembled bytes actually are — `ts` or `mp4`. */
  readonly extension: 'ts' | 'mp4';
  readonly mimeType: string;
  readonly segmentCount: number;
  /** Every origin the assembly read from, for the permission the caller requested. */
  readonly origins: readonly string[];
}

/** `hls` / `dash` when the URL names a manifest this module can attempt. */
export function detectStreamKind(url: string): StreamKind | undefined {
  const manifest = manifestTypeFromUrl(url);
  if (manifest === 'hls') {
    return 'hls';
  }
  if (manifest === 'dash') {
    return 'dash';
  }
  return undefined;
}

function originOf(url: string): string | undefined {
  try {
    return `${new URL(url).origin}/*`;
  } catch {
    return undefined;
  }
}

/**
 * The host patterns assembly will need. Only the manifest's own origin is knowable
 * before it is read; segments frequently live elsewhere, so the caller re-checks
 * with {@link AssembledStream.origins} after the fact and asks again if needed.
 */
export function streamOriginsFor(manifestUrl: string): readonly string[] {
  const origin = originOf(manifestUrl);
  return origin === undefined ? [] : [origin];
}

function fail(message: string, code: string, retryable = false): StreamAssemblyError {
  return new StreamAssemblyError(message, {
    code,
    messageKey: 'error.download.stream',
    retryable,
  });
}

/** Extension implied by a segment URL: fragmented MP4 or MPEG-TS. */
function containerFor(segmentUrl: string): 'ts' | 'mp4' {
  const path = segmentUrl.split(/[?#]/)[0] ?? '';
  const extension = (path.split('.').pop() ?? '').toLowerCase();
  return extension === 'ts' || extension === 'm2ts' || extension === 'mts' ? 'ts' : 'mp4';
}

interface FetchPlan {
  readonly kind: StreamKind;
  readonly segments: readonly {
    readonly url: string;
    readonly range?: { readonly offset: number; readonly length: number };
  }[];
}

/**
 * The HTTP client throws (HttpError/NetworkError); assembly reports. This is the one
 * place that translation happens, so `code` and `retryable` survive into the queue.
 */
function describeHttpFailure(cause: unknown): {
  readonly code: string;
  readonly retryable: boolean;
} {
  if (cause instanceof PlatformError) {
    return { code: cause.code, retryable: cause.retryable };
  }
  return { code: 'http-unknown', retryable: false };
}

async function fetchText(
  http: HttpClient,
  url: string,
  signal: AbortSignal | undefined,
): Promise<Result<string, StreamAssemblyError>> {
  try {
    return ok(await http.getText(url, signal !== undefined ? { signal } : {}));
  } catch (cause) {
    const { code, retryable } = describeHttpFailure(cause);
    return err(
      fail(`Manifest could not be fetched (${code})`, 'stream-manifest-fetch-failed', retryable),
    );
  }
}

/** Resolve an HLS URL to a concrete segment list, following ONE master playlist. */
async function planHls(request: AssembleRequest): Promise<Result<FetchPlan, StreamAssemblyError>> {
  const { http, manifestUrl, signal } = request;
  let url = manifestUrl;

  for (let hop = 0; hop < 2; hop += 1) {
    const text = await fetchText(http, url, signal);
    if (!text.ok) {
      return text;
    }
    const playlist = parseHlsPlaylist(text.value, url);

    if (playlist.kind === 'refused') {
      return err(fail(playlist.reason, `stream-${playlist.code}`));
    }
    if (playlist.kind === 'master') {
      // Highest bandwidth wins; the user's quality choice is a later concern (§10.6).
      const best = [...playlist.variants].sort(
        (left, right) => (right.bandwidth ?? 0) - (left.bandwidth ?? 0),
      )[0];
      if (best === undefined) {
        return err(fail('Master playlist lists no usable variant', 'stream-hls-no-variant'));
      }
      url = best.url;
      continue;
    }
    if (playlist.live) {
      return err(fail('Live streams have no end to download', 'stream-hls-live'));
    }
    const segments: HlsSegment[] = [
      ...(playlist.initSegment !== undefined ? [playlist.initSegment] : []),
      ...playlist.segments,
    ];
    return ok({
      kind: 'hls',
      segments: segments.map((segment) => ({
        url: segment.url,
        ...(segment.range !== undefined && { range: segment.range }),
      })),
    });
  }
  return err(fail('Playlist nests master playlists too deeply', 'stream-hls-nested-master'));
}

async function planDash(request: AssembleRequest): Promise<Result<FetchPlan, StreamAssemblyError>> {
  const text = await fetchText(request.http, request.manifestUrl, request.signal);
  if (!text.ok) {
    return text;
  }
  const manifest = parseDashManifest(text.value, request.manifestUrl);
  if (manifest.kind === 'refused') {
    return err(fail(manifest.reason, `stream-${manifest.code}`));
  }
  if (manifest.kind === 'dynamic') {
    return err(fail(manifest.reason, 'stream-dash-dynamic'));
  }
  const representation: DashRepresentation | undefined =
    manifest.representations[manifest.defaultIndex];
  if (representation === undefined) {
    return err(fail('Manifest lists no usable representation', 'stream-dash-no-representation'));
  }
  const segments: DashSegment[] = [
    ...(representation.initSegment !== undefined ? [representation.initSegment] : []),
    ...representation.segments,
  ];
  return ok({
    kind: 'dash',
    segments: segments.map((segment) => ({
      url: segment.url,
      ...(segment.range !== undefined && { range: segment.range }),
    })),
  });
}

export async function assembleStream(
  request: AssembleRequest,
): Promise<Result<AssembledStream, StreamAssemblyError>> {
  const kind = detectStreamKind(request.manifestUrl);
  if (kind === undefined) {
    return err(fail('URL is not an HLS or DASH manifest', 'stream-not-a-manifest'));
  }

  const plan = kind === 'hls' ? await planHls(request) : await planDash(request);
  if (!plan.ok) {
    return plan;
  }
  const segments = plan.value.segments;
  if (segments.length === 0) {
    return err(fail('Manifest resolved to no segments', 'stream-empty'));
  }

  const ceiling = request.maxTotalBytes ?? STREAM_MAX_TOTAL_BYTES;
  // Read through a call: the flag flips DURING the awaits below, which narrowing
  // cannot know.
  const aborted = (): boolean => request.signal?.aborted === true;
  const parts: Uint8Array[] = [];
  const origins = new Set<string>();
  let byteLength = 0;

  // Sequential on purpose: playlist order IS the file order, and one transfer at a
  // time keeps peak memory to a single segment plus what has been kept (§12.1).
  for (const [index, segment] of segments.entries()) {
    if (aborted()) {
      return err(fail('Assembly was cancelled', 'stream-aborted'));
    }
    let received: Uint8Array;
    let finalUrl: string;
    try {
      const response = await request.http.get(segment.url, {
        ...(request.signal !== undefined && { signal: request.signal }),
        ...(segment.range !== undefined && {
          range: {
            first: segment.range.offset,
            last: segment.range.offset + segment.range.length - 1,
          },
        }),
        maxBytes: STREAM_MAX_SEGMENT_BYTES,
      });
      received = response.bytes;
      finalUrl = response.url;
    } catch (cause) {
      const { code, retryable } = describeHttpFailure(cause);
      return err(
        fail(
          `Segment ${String(index + 1)} of ${String(segments.length)} failed (${code})`,
          'stream-segment-failed',
          retryable,
        ),
      );
    }
    // Re-check AFTER the await: a cancel that arrived while this segment was in
    // flight must stop assembly here, not one segment later (§10.10).
    if (aborted()) {
      return err(fail('Assembly was cancelled', 'stream-aborted'));
    }
    byteLength += received.byteLength;
    if (byteLength > ceiling) {
      return err(
        fail('Stream is larger than the accepted ceiling for assembly', 'stream-too-large'),
      );
    }
    parts.push(received);
    const origin = originOf(finalUrl);
    if (origin !== undefined) {
      origins.add(origin);
    }
    request.onProgress?.({
      segmentsDone: index + 1,
      segmentsTotal: segments.length,
      bytesReceived: byteLength,
    });
  }

  const extension = containerFor(segments[0]?.url ?? '');
  return ok({
    kind,
    parts,
    byteLength,
    extension,
    mimeType: extension === 'ts' ? 'video/mp2t' : 'video/mp4',
    segmentCount: segments.length,
    origins: [...origins],
  });
}
