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
import { isProtectedStreamCode, streamMessageKeyFor } from '@shared/result/stream';
import { PlatformError } from '@shared/result/errors';
import { StreamAssemblyError, StreamProtectedError } from '@core/download/errors';
import { manifestTypeFromUrl } from '@shared/utils';
import type { HttpClient } from '@platform/http';
import {
  parseDashManifest,
  type DashRepresentation,
  type DashSegment,
} from '@core/download/stream/dash';
import {
  parseHlsPlaylist,
  type HlsAudioRendition,
  type HlsSegment,
} from '@core/download/stream/hls';
import { muxFragmentedMp4, splitFragmentedMp4, type Mp4Track } from '@core/download/stream/mux';

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

/**
 * A refusal is only useful if the surface can say WHY, so the code decides both the
 * class and the message key. The mapping lives in `shared` because the Chromium
 * client rebuilds these errors from the wire, where only the code survives (§20.5).
 */
function fail(message: string, code: string, retryable = false): StreamAssemblyError {
  const options = { code, messageKey: streamMessageKeyFor(code), retryable };
  // Encryption is not a network condition and must never be retried; it gets its own
  // class so every consumer classifies it as protected media (§6).
  return isProtectedStreamCode(code)
    ? (new StreamProtectedError(message, { ...options, retryable: false }) as StreamAssemblyError)
    : new StreamAssemblyError(message, options);
}

/** Extension implied by a segment URL: fragmented MP4 or MPEG-TS. */
function containerFor(segmentUrl: string): 'ts' | 'mp4' {
  const path = segmentUrl.split(/[?#]/)[0] ?? '';
  const extension = (path.split('.').pop() ?? '').toLowerCase();
  return extension === 'ts' || extension === 'm2ts' || extension === 'mts' ? 'ts' : 'mp4';
}

interface PlannedSegment {
  readonly url: string;
  readonly range?: { readonly offset: number; readonly length: number };
}

/**
 * What to fetch. `single` is one track already carrying both picture and sound;
 * `muxed` is a video track and an audio track that have to be joined into one file,
 * which is how most real DASH — and much HLS — is packaged (§10.6).
 */
type FetchPlan =
  | {
      readonly kind: StreamKind;
      readonly mode: 'single';
      readonly segments: readonly PlannedSegment[];
    }
  | {
      readonly kind: StreamKind;
      readonly mode: 'muxed';
      readonly video: readonly PlannedSegment[];
      readonly audio: readonly PlannedSegment[];
    };

/** Every segment a plan will fetch, in fetch order. */
function plannedSegments(plan: FetchPlan): readonly PlannedSegment[] {
  return plan.mode === 'single' ? plan.segments : [...plan.video, ...plan.audio];
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

/** Read one HLS media playlist into the segments it names, init segment first. */
async function planHlsMedia(
  request: AssembleRequest,
  url: string,
): Promise<Result<readonly PlannedSegment[], StreamAssemblyError>> {
  const text = await fetchText(request.http, url, request.signal);
  if (!text.ok) {
    return text;
  }
  const playlist = parseHlsPlaylist(text.value, url);
  if (playlist.kind === 'refused') {
    return err(fail(playlist.reason, `stream-${playlist.code}`));
  }
  if (playlist.kind === 'master') {
    return err(fail('A rendition pointed at another master playlist', 'stream-hls-nested-master'));
  }
  if (playlist.live) {
    return err(fail('Live streams have no end to download', 'stream-hls-live'));
  }
  const segments: HlsSegment[] = [
    ...(playlist.initSegment !== undefined ? [playlist.initSegment] : []),
    ...playlist.segments,
  ];
  return ok(
    segments.map((segment) => ({
      url: segment.url,
      ...(segment.range !== undefined && { range: segment.range }),
    })),
  );
}

/**
 * Whether a track's segments are fragmented MP4, which is what muxing needs. MPEG-TS
 * renditions would have to be demuxed and re-packaged — a different job, not started
 * here — so a TS stream with separate audio stays refused rather than half-supported.
 */
function isFragmentedTrack(segments: readonly PlannedSegment[]): boolean {
  return segments.every((segment) => containerFor(segment.url) === 'mp4');
}

/** The audio rendition to pair with a variant: its own group, default first. */
function chooseAudio(
  renditions: readonly HlsAudioRendition[],
  group: string | undefined,
): HlsAudioRendition | undefined {
  const candidates = group === undefined ? renditions : renditions.filter((r) => r.group === group);
  return candidates.find((rendition) => rendition.isDefault) ?? candidates[0];
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
      // A variant whose audio lives in its own rendition carries video only. Both
      // tracks are fetched and joined into one file; saving the video track alone
      // would be a silent video (§10.6).
      const audioIsSeparate =
        best.audioGroup !== undefined
          ? playlist.separateAudioGroups.includes(best.audioGroup)
          : playlist.separateAudioGroups.length > 0;
      if (!audioIsSeparate) {
        url = best.url;
        continue;
      }
      const rendition = chooseAudio(playlist.audioRenditions, best.audioGroup);
      if (rendition === undefined) {
        return err(
          fail(
            'This stream names a separate audio track it does not provide',
            'stream-hls-separate-audio',
          ),
        );
      }
      const videoSegments = await planHlsMedia(request, best.url);
      if (!videoSegments.ok) {
        return videoSegments;
      }
      const audioSegments = await planHlsMedia(request, rendition.url);
      if (!audioSegments.ok) {
        return audioSegments;
      }
      if (!isFragmentedTrack(videoSegments.value) || !isFragmentedTrack(audioSegments.value)) {
        // MPEG-TS renditions would have to be demuxed and re-packaged, which this
        // project does not do. Refused, with the reason, rather than saved silent.
        return err(
          fail(
            'This stream keeps its audio in a separate MPEG-TS track, which cannot be joined into one file',
            'stream-hls-separate-audio',
          ),
        );
      }
      return ok({
        kind: 'hls',
        mode: 'muxed',
        video: videoSegments.value,
        audio: audioSegments.value,
      });
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
      mode: 'single',
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
  // Video in one AdaptationSet and audio in another means no single representation
  // holds both, so saving one of them alone would be a silent video. Both are fetched
  // and joined into one file instead (§10.6).
  const best = (kind: 'video' | 'audio'): DashRepresentation | undefined =>
    [...manifest.representations]
      .filter((entry) => entry.contentType === kind)
      .sort((left, right) => (right.bandwidth ?? 0) - (left.bandwidth ?? 0))[0];
  const video = best('video');
  const audio = best('audio');

  if (video !== undefined && audio !== undefined && video.setIndex !== audio.setIndex) {
    return ok({
      kind: 'dash',
      mode: 'muxed',
      video: segmentsOf(video),
      audio: segmentsOf(audio),
    });
  }
  return ok({ kind: 'dash', mode: 'single', segments: segmentsOf(representation) });
}

/** A representation's segments, its initialisation segment first. */
function segmentsOf(representation: DashRepresentation): readonly PlannedSegment[] {
  const segments: DashSegment[] = [
    ...(representation.initSegment !== undefined ? [representation.initSegment] : []),
    ...representation.segments,
  ];
  return segments.map((segment) => ({
    url: segment.url,
    ...(segment.range !== undefined && { range: segment.range }),
  }));
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
  const all = plannedSegments(plan.value);
  if (all.length === 0) {
    return err(fail('Manifest resolved to no segments', 'stream-empty'));
  }

  const state: FetchState = {
    ceiling: request.maxTotalBytes ?? STREAM_MAX_TOTAL_BYTES,
    byteLength: 0,
    origins: new Set<string>(),
    done: 0,
    total: all.length,
  };

  if (plan.value.mode === 'single') {
    const fetched = await fetchSegments(request, plan.value.segments, state);
    if (!fetched.ok) {
      return fetched;
    }
    const extension = containerFor(plan.value.segments[0]?.url ?? '');
    return ok({
      kind,
      parts: fetched.value,
      byteLength: state.byteLength,
      extension,
      mimeType: extension === 'ts' ? 'video/mp2t' : 'video/mp4',
      segmentCount: plan.value.segments.length,
      origins: [...state.origins],
    });
  }

  // Two tracks: video first, then audio, then joined into one file.
  const video = await fetchSegments(request, plan.value.video, state);
  if (!video.ok) {
    return video;
  }
  const audio = await fetchSegments(request, plan.value.audio, state);
  if (!audio.ok) {
    return audio;
  }
  const muxed = muxFragmentedMp4({
    video: toMp4Track(video.value),
    audio: toMp4Track(audio.value),
  });
  if (!muxed.ok) {
    return err(muxed.error);
  }
  const byteLength = muxed.value.reduce((sum, part) => sum + part.byteLength, 0);
  return ok({
    kind,
    parts: muxed.value,
    byteLength,
    extension: 'mp4',
    mimeType: 'video/mp4',
    segmentCount: plan.value.video.length + plan.value.audio.length,
    origins: [...state.origins],
  });
}

interface FetchState {
  readonly ceiling: number;
  byteLength: number;
  readonly origins: Set<string>;
  /** Segments fetched so far across every track, for one honest progress count. */
  done: number;
  readonly total: number;
}

/**
 * Fetch one track's segments, in order.
 *
 * Sequential on purpose: playlist order IS the file order, and one transfer at a time
 * keeps peak memory to a single segment plus what has been kept (§12.1).
 */
async function fetchSegments(
  request: AssembleRequest,
  segments: readonly PlannedSegment[],
  state: FetchState,
): Promise<Result<Uint8Array[], StreamAssemblyError>> {
  // Read through a call: the flag flips DURING the awaits below, which narrowing
  // cannot know.
  const aborted = (): boolean => request.signal?.aborted === true;
  const parts: Uint8Array[] = [];

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
      if (segment.range !== undefined) {
        // A server that ignores `Range` answers 200 with the WHOLE resource. Appending
        // that would silently corrupt the output, so the mismatch is a failure.
        if (response.status !== 206) {
          return err(
            fail(
              `Segment ${String(index + 1)} was answered without the byte range it asked for`,
              'stream-range-ignored',
            ),
          );
        }
        if (received.byteLength !== segment.range.length) {
          return err(
            fail(
              `Segment ${String(index + 1)} returned ${String(received.byteLength)} bytes for a ${String(segment.range.length)}-byte range`,
              'stream-range-mismatch',
            ),
          );
        }
      }
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
    state.byteLength += received.byteLength;
    if (state.byteLength > state.ceiling) {
      return err(
        fail('Stream is larger than the accepted ceiling for assembly', 'stream-too-large'),
      );
    }
    parts.push(received);
    const origin = originOf(finalUrl);
    if (origin !== undefined) {
      state.origins.add(origin);
    }
    state.done += 1;
    request.onProgress?.({
      segmentsDone: state.done,
      segmentsTotal: state.total,
      bytesReceived: state.byteLength,
    });
  }
  return ok(parts);
}

/**
 * Turn fetched segments into a track the muxer can read. Each segment is split on its
 * own rather than concatenating the track first: it avoids a second full-size copy,
 * and it handles a segment that carries several fragments.
 */
function toMp4Track(parts: readonly Uint8Array[]): Mp4Track {
  const inits: Uint8Array[] = [];
  const fragments: Uint8Array[] = [];
  for (const part of parts) {
    const split = splitFragmentedMp4(part);
    if (split.init.byteLength > 0) {
      inits.push(split.init);
    }
    fragments.push(...split.fragments);
  }
  const initLength = inits.reduce((sum, part) => sum + part.byteLength, 0);
  const init = new Uint8Array(initLength);
  let at = 0;
  for (const part of inits) {
    init.set(part, at);
    at += part.byteLength;
  }
  return { init, fragments };
}
