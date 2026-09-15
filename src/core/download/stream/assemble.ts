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
 *          detectStreamKind, streamOriginsFor, planStream, assembleStream,
 *          listStreamRenditions, PlannedSegment, FetchPlan.
 */
import { err, ok, type Result } from '@shared/result';
import {
  isProtectedStreamCode,
  streamMessageKeyFor,
  STREAM_HOST_NOT_PERMITTED,
} from '@shared/result/stream';
import { PlatformError } from '@shared/result/errors';
import { StreamAssemblyError, StreamProtectedError } from '@core/download/errors';
import { manifestTypeFromUrl, sniffFormat } from '@shared/utils';
import type { HttpClient, HttpResponse } from '@platform/http';
import {
  parseDashManifest,
  type DashRepresentation,
  type DashSegment,
} from '@core/download/stream/dash';
import {
  parseHlsPlaylist,
  type HlsAudioRendition,
  type HlsSegment,
  type HlsVariant,
} from '@core/download/stream/hls';
import { muxFragmentedMp4, trackFromSegments, type Mp4Track } from '@core/download/stream/mux';
import { writeFragmentedMp4 } from '@core/download/stream/mp4write';
import { demuxMpegTs, demuxPackedAudio, TS_CLOCK_HZ } from '@core/download/stream/ts';
import {
  selectRendition,
  type Rendition,
  type StreamSelection,
} from '@core/download/stream/quality';
import type { StreamRenditionSnapshot } from '@shared/types';

/**
 * Assembly holds the finished media in memory before handing it to the browser, so
 * the ceiling is a refusal, not a target. A stream past it is reported as too large
 * rather than being attempted and killing the worker (§12.1, §10.9).
 */
export const STREAM_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
/** One segment is never legitimately this big; a hostile server's would be. */
export const STREAM_MAX_SEGMENT_BYTES = 64 * 1024 * 1024;

/**
 * How long one segment may take.
 *
 * Deliberately far above the HTTP client's default: hosts throttle anonymous
 * sequential reads, and measured against a real one the same segment size went from
 * 150 ms to 44 seconds as a download progressed. A slow host is not a broken host, and
 * failing a 300-segment download over one slow segment throws away everything fetched
 * so far.
 */
export const STREAM_SEGMENT_TIMEOUT_MS = 120_000;

/**
 * Attempts per segment, including the first.
 *
 * Retried HERE rather than by the queue, because the queue's retry restarts assembly
 * from the first segment: on a 331-segment stream that turns one hiccup into hours of
 * refetching (§10.4).
 */
export const STREAM_SEGMENT_ATTEMPTS = 5;

/**
 * How long to keep trying ONE segment before giving up on the download.
 *
 * Hosts throttle anonymous sequential reads — measured on a real one, the same segment
 * size went from 150 ms to 44 seconds and then to nothing at all. Waiting a while is
 * the honest response to a host that is slow on purpose; waiting forever is not, so the
 * attempts are bounded in wall-clock as well as in count.
 */
export const STREAM_SEGMENT_BUDGET_MS = 5 * 60 * 1000;

/** First backoff step; each attempt waits twice as long as the one before. */
export const STREAM_RETRY_BASE_MS = 2000;

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
  /**
   * Which rendition to take: the user's pinned choice, or the standing quality
   * preference (§10.6). Omitted keeps the original behaviour — highest bandwidth.
   */
  readonly selection?: StreamSelection;
  /**
   * What detection established this manifest is, from its BYTES, when its URL does
   * not say — a host that serves a playlist as `.txt` would otherwise be refused here
   * as "not a manifest" after having been correctly detected (§9.1, ADR-012).
   */
  readonly kind?: StreamKind;
  /** Overrides {@link STREAM_SEGMENT_TIMEOUT_MS} (tests, and callers that know better). */
  readonly segmentTimeoutMs?: number;
  /** Overrides {@link STREAM_SEGMENT_ATTEMPTS}. */
  readonly segmentAttempts?: number;
  /** Overrides {@link STREAM_SEGMENT_BUDGET_MS}: the wall-clock cap on one segment. */
  readonly segmentBudgetMs?: number;
  /** Overrides {@link STREAM_RETRY_BASE_MS}. */
  readonly retryBaseMs?: number;
  /** Injectable delay, so tests do not wait in real time. */
  readonly wait?: (ms: number) => Promise<void>;
  /** Injectable clock, for the same reason. */
  readonly clock?: () => number;
  /**
   * Whether the extension is allowed to read this origin at all.
   *
   * A cross-origin read the extension holds no permission for rejects with the same
   * `TypeError` as a dropped connection, so assembly could not tell "the network
   * blipped" from "we may not look" — and retried the second one five times with
   * backoff, per segment. Segments routinely live on an origin the MANIFEST's grant
   * never covered, which is exactly when this fires (§13.7, §20.3).
   *
   * Optional: a caller that cannot answer simply keeps the old behaviour.
   */
  readonly isHostPermitted?: (origin: string) => Promise<boolean>;
}

export interface AssembledStream {
  readonly kind: StreamKind;
  /** Segment payloads in playlist order; the caller concatenates or streams them. */
  readonly parts: readonly Uint8Array[];
  readonly byteLength: number;
  /** Container the assembled bytes actually are — `ts`, `aac` or `mp4`. */
  readonly extension: 'ts' | 'aac' | 'mp4';
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
function fail(
  message: string,
  code: string,
  retryable = false,
  context?: Readonly<Record<string, unknown>>,
): StreamAssemblyError {
  const options = {
    code,
    messageKey: streamMessageKeyFor(code),
    retryable,
    ...(context !== undefined && { context }),
  };
  // Encryption is not a network condition and must never be retried; it gets its own
  // class so every consumer classifies it as protected media (§6).
  return isProtectedStreamCode(code)
    ? (new StreamProtectedError(message, { ...options, retryable: false }) as StreamAssemblyError)
    : new StreamAssemblyError(message, options);
}

/** The containers assembly can hand on or take apart. */
type SegmentContainer = 'ts' | 'aac' | 'mp4';

/**
 * What a segment URL CLAIMS to be. Used only when the bytes are not in hand yet, and
 * always superseded by {@link containerOfSegment} once they are.
 */
function containerFromUrl(segmentUrl: string): SegmentContainer {
  const path = segmentUrl.split(/[?#]/)[0] ?? '';
  const extension = (path.split('.').pop() ?? '').toLowerCase();
  if (extension === 'ts' || extension === 'm2ts' || extension === 'mts') {
    return 'ts';
  }
  return extension === 'aac' || extension === 'adts' ? 'aac' : 'mp4';
}

/**
 * What a segment ACTUALLY is, decided by its first bytes and falling back to its URL
 * only when the bytes say nothing recognisable.
 *
 * Names lie, and not always by accident: a real video host serves MPEG-TS segments
 * with a `.css` extension as `text/css`. Trusting the extension there produced a file
 * called `.mp4` containing transport-stream bytes — the wrong container, the wrong
 * name, and the wrong code path for anything that had to be re-packaged (§5.1, §10.7).
 */
function containerOfSegment(bytes: Uint8Array | undefined, segmentUrl: string): SegmentContainer {
  const sniffed = bytes === undefined ? undefined : sniffFormat(bytes);
  if (sniffed === 'mpeg-ts') {
    return 'ts';
  }
  if (sniffed === 'adts') {
    return 'aac';
  }
  if (sniffed === 'mp4' || sniffed === 'webm') {
    return 'mp4';
  }
  return containerFromUrl(segmentUrl);
}

export interface PlannedSegment {
  readonly url: string;
  readonly range?: { readonly offset: number; readonly length: number };
}

/**
 * What to fetch. `single` is one track already carrying both picture and sound;
 * `muxed` is a video track and an audio track that have to be joined into one file,
 * which is how most real DASH — and much HLS — is packaged (§10.6).
 */
export type FetchPlan =
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

/** An HLS variant as something {@link selectRendition} can rank; its URL is its id. */
function renditionOfVariant(variant: HlsVariant): Rendition {
  return {
    id: variant.url,
    ...(variant.bandwidth !== undefined && { bandwidth: variant.bandwidth }),
    ...(variant.width !== undefined && { width: variant.width }),
    ...(variant.height !== undefined && { height: variant.height }),
    ...(variant.codecs !== undefined && { codecs: variant.codecs }),
  };
}

/**
 * A DASH representation's selection id.
 *
 * The AdaptationSet index is part of it because `Representation@id` is only required
 * to be unique within its own set, and a picker that offers two entries with the same
 * id cannot honour either of them reliably.
 */
function representationKey(representation: DashRepresentation): string {
  return `${String(representation.setIndex)}/${representation.id}`;
}

function renditionOfRepresentation(representation: DashRepresentation): Rendition {
  return {
    id: representationKey(representation),
    ...(representation.bandwidth !== undefined && { bandwidth: representation.bandwidth }),
    ...(representation.width !== undefined && { width: representation.width }),
    ...(representation.height !== undefined && { height: representation.height }),
    ...(representation.codecs !== undefined && { codecs: representation.codecs }),
  };
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
      // Which variant to take is the user's call: a pinned rendition, else the
      // quality preference, else the highest bandwidth on offer (§10.6).
      const chosen = selectRendition(playlist.variants.map(renditionOfVariant), request.selection);
      const best = playlist.variants.find((variant) => variant.url === chosen?.id);
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
  if (manifest.representations.length === 0) {
    return err(fail('Manifest lists no usable representation', 'stream-dash-no-representation'));
  }
  // Video in one AdaptationSet and audio in another means no single representation
  // holds both, so saving one of them alone would be a silent video. Both are fetched
  // and joined into one file instead (§10.6).
  const ofKind = (kind: 'video' | 'audio'): readonly DashRepresentation[] =>
    manifest.representations.filter((entry) => entry.contentType === kind);
  /** The video track honours the user's choice; audio is taken at its best. */
  const pick = (
    candidates: readonly DashRepresentation[],
    selection: StreamSelection | undefined,
  ): DashRepresentation | undefined => {
    const chosen = selectRendition(candidates.map(renditionOfRepresentation), selection);
    return candidates.find((entry) => representationKey(entry) === chosen?.id);
  };
  const video = pick(ofKind('video'), request.selection);
  const audio = pick(ofKind('audio'), undefined);
  const representation =
    pick(
      ofKind('video').length > 0 ? ofKind('video') : manifest.representations,
      request.selection,
    ) ?? manifest.representations[manifest.defaultIndex];
  if (representation === undefined) {
    return err(fail('Manifest lists no usable representation', 'stream-dash-no-representation'));
  }

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

/**
 * List what a stream offers, so the user can choose before anything is queued
 * (§10.6).
 *
 * Reads the manifest and nothing else: no segment, no rendition playlist. A stream
 * with only one rendition — a media playlist handed to us directly, a single-quality
 * manifest — returns an empty list, because there is nothing to choose and offering a
 * choice of one would be theatre.
 */
export async function listStreamRenditions(
  request: AssembleRequest,
): Promise<Result<readonly StreamRenditionSnapshot[], StreamAssemblyError>> {
  const kind = request.kind ?? detectStreamKind(request.manifestUrl);
  if (kind === undefined) {
    return err(fail('URL is not an HLS or DASH manifest', 'stream-not-a-manifest'));
  }
  const text = await fetchText(request.http, request.manifestUrl, request.signal);
  if (!text.ok) {
    return text;
  }

  if (kind === 'hls') {
    const playlist = parseHlsPlaylist(text.value, request.manifestUrl);
    if (playlist.kind === 'refused') {
      return err(fail(playlist.reason, `stream-${playlist.code}`));
    }
    if (playlist.kind !== 'master') {
      return ok([]);
    }
    const renditions = playlist.variants.map(renditionOfVariant);
    const preferred = selectRendition(renditions, request.selection);
    return ok(
      playlist.variants.map((variant, index) =>
        snapshotOf(renditions[index] ?? { id: variant.url }, 'video', preferred?.id),
      ),
    );
  }

  const manifest = parseDashManifest(text.value, request.manifestUrl);
  if (manifest.kind === 'refused') {
    return err(fail(manifest.reason, `stream-${manifest.code}`));
  }
  if (manifest.kind === 'dynamic') {
    return err(fail(manifest.reason, 'stream-dash-dynamic'));
  }
  const videoReps = manifest.representations.filter((entry) => entry.contentType === 'video');
  // Audio-only representations are reported so a surface can show what will be
  // joined in, but they are not choices: the video track is what quality means here.
  const choosable = videoReps.length > 0 ? videoReps : manifest.representations;
  const preferred = selectRendition(choosable.map(renditionOfRepresentation), request.selection);
  return ok(
    manifest.representations.map((representation) =>
      snapshotOf(
        renditionOfRepresentation(representation),
        representation.contentType === 'audio' ? 'audio' : 'video',
        preferred?.id,
      ),
    ),
  );
}

function snapshotOf(
  rendition: Rendition,
  streamKind: 'video' | 'audio',
  preferredId: string | undefined,
): StreamRenditionSnapshot {
  return {
    id: rendition.id,
    kind: streamKind,
    ...(rendition.bandwidth !== undefined && { bandwidth: rendition.bandwidth }),
    ...(rendition.width !== undefined && { width: rendition.width }),
    ...(rendition.height !== undefined && { height: rendition.height }),
    ...(rendition.codecs !== undefined && { codecs: rendition.codecs }),
    isPreferred: rendition.id === preferredId,
  };
}

/**
 * Resolve a manifest to exactly what assembly would fetch, without fetching any of it.
 *
 * Exported so the real-world conformance harness (`tests/live`) drives the SAME
 * selection and refusal logic a download does, instead of a copy of it that could
 * drift and validate nothing (§16.9).
 */
export async function planStream(
  request: AssembleRequest,
): Promise<Result<FetchPlan, StreamAssemblyError>> {
  const kind = request.kind ?? detectStreamKind(request.manifestUrl);
  if (kind === undefined) {
    return err(fail('URL is not an HLS or DASH manifest', 'stream-not-a-manifest'));
  }
  return kind === 'hls' ? planHls(request) : planDash(request);
}

/**
 * Turn one track's fetched segments into a fragmented-MP4 track the muxer can join.
 *
 * Fragmented-MP4 segments are already in that shape and are used verbatim. MPEG-TS
 * segments are not tracks at all — audio and video are cut into 188-byte packets — so
 * they are demultiplexed and re-packaged: the compressed samples are copied unchanged
 * and only the framing around them is rewritten (§10.6).
 */
function trackForSlot(
  kind: 'video' | 'audio',
  segments: readonly PlannedSegment[],
  parts: Uint8Array[],
): Result<Mp4Track, StreamAssemblyError> {
  const container = containerOfSegment(parts[0], segments[0]?.url ?? '');
  if (container === 'mp4') {
    return ok(trackFromSegments(parts));
  }
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.byteLength;
  }
  // The fetched segments are no longer needed once joined; releasing them here keeps
  // peak memory to the joined stream plus what the remux produces (§12.1).
  parts.length = 0;

  const demuxed = container === 'aac' ? demuxPackedAudio(joined) : demuxMpegTs(joined);
  if (!demuxed.ok) {
    return demuxed;
  }
  const track = demuxed.value.tracks.find((candidate) => candidate.kind === kind);
  if (track === undefined) {
    return err(
      fail(
        `This stream's ${kind} rendition carries no ${kind} track this build can read`,
        'stream-ts-track-missing',
      ),
    );
  }
  return writeFragmentedMp4(track, {
    trackId: 1,
    // Each rendition is its own file, so each starts at its own first sample. Within
    // one transport stream the two tracks would share an origin; across two renditions
    // they can differ by up to a frame, which is stated rather than hidden (§2.8).
    originTicks90k: (track.samples[0]?.dts ?? 0) * (TS_CLOCK_HZ / track.timescale),
  });
}

export async function assembleStream(
  request: AssembleRequest,
): Promise<Result<AssembledStream, StreamAssemblyError>> {
  const kind = request.kind ?? detectStreamKind(request.manifestUrl);
  if (kind === undefined) {
    return err(fail('URL is not an HLS or DASH manifest', 'stream-not-a-manifest'));
  }

  const plan = await planStream(request);
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
    const container = containerOfSegment(fetched.value[0], plan.value.segments[0]?.url ?? '');
    // A rendition of bare ADTS frames is an audio file; saving it as `.mp4` would name
    // it something it is not (§10.7).
    const extension = container === 'aac' ? 'aac' : container;
    return ok({
      kind,
      parts: fetched.value,
      byteLength: state.byteLength,
      extension,
      mimeType: container === 'ts' ? 'video/mp2t' : container === 'aac' ? 'audio/aac' : 'video/mp4',
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
  const videoTrack = trackForSlot('video', plan.value.video, video.value);
  if (!videoTrack.ok) {
    return videoTrack;
  }
  const audioTrack = trackForSlot('audio', plan.value.audio, audio.value);
  if (!audioTrack.ok) {
    return audioTrack;
  }
  const muxed = muxFragmentedMp4({ video: videoTrack.value, audio: audioTrack.value });
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
 * Fetch one segment, retrying a transport failure a bounded number of times.
 *
 * Only retryable failures are retried: a refusal about what the stream IS never
 * becomes true on a second attempt, and retrying it would only waste the user's time
 * (§10.4). The delay between attempts is short and fixed — this is riding out a
 * throttle, not backing off a queue.
 */
/** A match pattern (`https://host/*`) as the host a person would recognise. */
function hostOf(pattern: string): string {
  return pattern.replace(/^https?:\/\//i, '').replace(/\/\*$/, '');
}

/**
 * The origin this failure is about, when the reason is that we may not read it.
 *
 * Only a transport-level failure can be a permission problem: a host that ANSWERS —
 * with a 403, a 404, a 500 — is one the browser let us reach, whatever it then said.
 */
async function unpermittedOrigin(
  request: AssembleRequest,
  url: string,
  cause: unknown,
): Promise<string | undefined> {
  if (request.isHostPermitted === undefined) {
    return undefined;
  }
  const { code } = describeHttpFailure(cause);
  if (code !== 'http-network-failed' && code !== 'http-unknown') {
    return undefined;
  }
  const origin = originOf(url);
  if (origin === undefined) {
    return undefined;
  }
  try {
    return (await request.isHostPermitted(origin)) ? undefined : origin;
  } catch {
    // Unable to tell: fall back to treating it as the transport failure it looked like.
    return undefined;
  }
}

async function fetchWithRetries(
  request: AssembleRequest,
  segment: PlannedSegment,
): Promise<HttpResponse> {
  const attempts = Math.max(1, request.segmentAttempts ?? STREAM_SEGMENT_ATTEMPTS);
  const budgetMs = request.segmentBudgetMs ?? STREAM_SEGMENT_BUDGET_MS;
  const baseDelay = request.retryBaseMs ?? STREAM_RETRY_BASE_MS;
  const wait = request.wait ?? defaultWait;
  const startedAt = request.clock?.() ?? Date.now();
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await request.http.get(segment.url, {
        ...(request.signal !== undefined && { signal: request.signal }),
        ...(segment.range !== undefined && {
          range: {
            first: segment.range.offset,
            last: segment.range.offset + segment.range.length - 1,
          },
        }),
        maxBytes: STREAM_MAX_SEGMENT_BYTES,
        timeoutMs: request.segmentTimeoutMs ?? STREAM_SEGMENT_TIMEOUT_MS,
      });
    } catch (cause) {
      lastError = cause;
      // Before treating this as weather: is it even allowed? Asked only once the read
      // has actually failed, so a permitted host costs nothing (§13.7).
      const refused = await unpermittedOrigin(request, segment.url, cause);
      if (refused !== undefined) {
        throw fail(
          `AetherDL is not allowed to read ${hostOf(refused)}, where this stream's segments are served from`,
          STREAM_HOST_NOT_PERMITTED,
          false,
          // The match pattern, because that is what a permission request takes; the
          // surface shows the host and asks for exactly this (§13.7).
          { origin: refused, host: hostOf(refused) },
        );
      }
      const retryable = cause instanceof PlatformError && cause.retryable;
      const elapsed = (request.clock?.() ?? Date.now()) - startedAt;
      if (
        !retryable ||
        attempt === attempts ||
        elapsed >= budgetMs ||
        request.signal?.aborted === true
      ) {
        throw cause;
      }
      // Backing OFF, not hammering: a host that is rate-limiting is answering the
      // question "please stop for a moment", and the polite reading of that is also
      // the effective one.
      await wait(baseDelay * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

/** Real time between retries; tests inject their own so they stay instant. */
function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
      const response = await fetchWithRetries(request, segment);
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
      // A refusal that already knows what it is — "this host is not granted" — keeps
      // its own code, its own retryability and its own context. Re-describing it as a
      // generic segment failure is what put a permission question back into the retry
      // loop it was raised to escape (§20.5).
      if (cause instanceof StreamAssemblyError || cause instanceof StreamProtectedError) {
        return err(cause as StreamAssemblyError);
      }
      const { code, retryable } = describeHttpFailure(cause);
      // A host that answered the first segments and then stopped is rate-limiting, not
      // broken, and saying so is more useful than "a segment failed" — it tells the
      // user the stream is fine and the host is throttling them (§20.5, §2.8).
      const throttled = index > 0 && (code === 'http-timeout' || code === 'http-network-failed');
      return err(
        fail(
          throttled
            ? `The host stopped answering after ${String(index)} of ${String(segments.length)} segments (${code}); it is rate-limiting this download`
            : `Segment ${String(index + 1)} of ${String(segments.length)} failed (${code})`,
          throttled ? 'stream-host-throttled' : 'stream-segment-failed',
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
