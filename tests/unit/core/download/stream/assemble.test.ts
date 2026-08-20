/**
 * Stream assembly (PROJECT_BIBLE.md §10.6, §6). Assembly performs no I/O of its own:
 * every test drives it with a stub HttpClient, which also proves the domain layer
 * never reaches for a browser global.
 */
import { describe, expect, it, vi } from 'vitest';
import { HttpError, NetworkError } from '@shared/result/errors';
import type { HttpClient, HttpRequestOptions, HttpResponse } from '@platform/http';
import {
  bytesOf,
  fragment,
  initSegment,
  joinBytes,
  readBoxes,
  sequencesOf,
  trackIdsOf,
} from './_fmp4';
import {
  assembleStream,
  detectStreamKind,
  streamOriginsFor,
  STREAM_MAX_SEGMENT_BYTES,
} from '@core/download/stream/assemble';

const bytes = (fill: number, length = 4): Uint8Array => new Uint8Array(length).fill(fill);

function stubHttp(
  routes: Readonly<Record<string, string | Uint8Array | Error>>,
  onRequest?: (url: string, options?: HttpRequestOptions) => void,
  /** Answer range requests the way a broken server would: 200 and the whole file. */
  ignoreRanges = false,
): HttpClient {
  const answer = (url: string, options?: HttpRequestOptions): HttpResponse => {
    onRequest?.(url, options);
    const route = routes[url];
    if (route === undefined) {
      throw new HttpError(`Request answered 404`, {
        code: 'http-404',
        messageKey: 'error.http',
        retryable: false,
      });
    }
    if (route instanceof Error) {
      throw route;
    }
    const body = typeof route === 'string' ? new TextEncoder().encode(route) : route;
    if (options?.range === undefined || ignoreRanges) {
      return { status: 200, ok: true, headers: {}, bytes: body, url };
    }
    // A server honouring the range returns 206 and exactly the slice asked for.
    const end = options.range.last === undefined ? body.byteLength : options.range.last + 1;
    return {
      status: 206,
      ok: true,
      headers: {},
      bytes: body.subarray(options.range.first, end),
      url,
    };
  };
  return {
    get: (url, options): Promise<HttpResponse> => Promise.resolve(answer(url, options)),
    getText: (url, options): Promise<string> =>
      Promise.resolve(new TextDecoder().decode(answer(url, options).bytes)),
  };
}

describe('detectStreamKind / streamOriginsFor', () => {
  it('recognises manifests and nothing else', () => {
    expect(detectStreamKind('https://a.test/x.m3u8')).toBe('hls');
    expect(detectStreamKind('https://a.test/x.m3u8?token=1')).toBe('hls');
    expect(detectStreamKind('https://a.test/x.mpd')).toBe('dash');
    expect(detectStreamKind('https://a.test/x.mp4')).toBeUndefined();
  });

  it('names the manifest origin as the permission to request', () => {
    expect(streamOriginsFor('https://cdn.test/a/b/x.m3u8')).toEqual(['https://cdn.test/*']);
    expect(streamOriginsFor('nonsense')).toEqual([]);
  });
});

describe('assembleStream: HLS', () => {
  const master = 'https://cdn.test/hls/master.m3u8';

  it('follows a master playlist to its highest-bandwidth variant and joins segments', async () => {
    const seen: string[] = [];
    const http = stubHttp(
      {
        [master]: [
          '#EXTM3U',
          '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360',
          'low.m3u8',
          '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080',
          'high.m3u8',
        ].join('\n'),
        'https://cdn.test/hls/high.m3u8': [
          '#EXTM3U',
          '#EXTINF:4,',
          'a.ts',
          '#EXTINF:4,',
          'b.ts',
          '#EXT-X-ENDLIST',
        ].join('\n'),
        'https://cdn.test/hls/a.ts': bytes(1, 10),
        'https://cdn.test/hls/b.ts': bytes(2, 6),
      },
      (url) => seen.push(url),
    );

    const result = await assembleStream({ manifestUrl: master, http });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toMatchObject({
      kind: 'hls',
      byteLength: 16,
      segmentCount: 2,
      extension: 'ts',
      mimeType: 'video/mp2t',
      origins: ['https://cdn.test/*'],
    });
    expect(result.value.parts.map((part) => part.byteLength)).toEqual([10, 6]);
    // The low variant is never fetched.
    expect(seen).not.toContain('https://cdn.test/hls/low.m3u8');
  });

  it('reports progress once per segment, in order', async () => {
    const http = stubHttp({
      [master]: ['#EXTM3U', '#EXTINF:4,', 'a.ts', '#EXTINF:4,', 'b.ts', '#EXT-X-ENDLIST'].join(
        '\n',
      ),
      'https://cdn.test/hls/a.ts': bytes(1, 8),
      'https://cdn.test/hls/b.ts': bytes(2, 8),
    });
    const onProgress = vi.fn();

    await assembleStream({ manifestUrl: master, http, onProgress });

    expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { segmentsDone: 1, segmentsTotal: 2, bytesReceived: 8 },
      { segmentsDone: 2, segmentsTotal: 2, bytesReceived: 16 },
    ]);
  });

  it('puts the EXT-X-MAP initialisation segment first and reports an mp4 container', async () => {
    const http = stubHttp({
      [master]: [
        '#EXTM3U',
        '#EXT-X-MAP:URI="init.mp4"',
        '#EXTINF:4,',
        'a.m4s',
        '#EXT-X-ENDLIST',
      ].join('\n'),
      'https://cdn.test/hls/init.mp4': bytes(9, 2),
      'https://cdn.test/hls/a.m4s': bytes(1, 4),
    });

    const result = await assembleStream({ manifestUrl: master, http });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.segmentCount).toBe(2);
    expect(result.value.parts[0]?.byteLength).toBe(2);
    expect(result.value.extension).toBe('mp4');
    expect(result.value.mimeType).toBe('video/mp4');
  });

  it('requests the exact byte range a playlist declares', async () => {
    const ranges: (HttpRequestOptions | undefined)[] = [];
    const http = stubHttp(
      {
        [master]: [
          '#EXTM3U',
          '#EXTINF:4,',
          '#EXT-X-BYTERANGE:100@0',
          'all.ts',
          '#EXT-X-ENDLIST',
        ].join('\n'),
        'https://cdn.test/hls/all.ts': bytes(1, 100),
      },
      (_url, options) => ranges.push(options),
    );

    await assembleStream({ manifestUrl: master, http });

    expect(ranges.at(-1)?.range).toEqual({ first: 0, last: 99 });
    expect(ranges.at(-1)?.maxBytes).toBe(STREAM_MAX_SEGMENT_BYTES);
  });

  it('refuses a live playlist', async () => {
    const http = stubHttp({
      [master]: ['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXTINF:4,', 'a.ts'].join('\n'),
    });

    const result = await assembleStream({ manifestUrl: master, http });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe('stream-hls-live');
  });

  it('refuses an encrypted playlist without fetching a single segment or key', async () => {
    const seen: string[] = [];
    const http = stubHttp(
      {
        [master]: [
          '#EXTM3U',
          '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.test/k.bin"',
          '#EXTINF:4,',
          'a.ts',
          '#EXT-X-ENDLIST',
        ].join('\n'),
        'https://cdn.test/hls/a.ts': bytes(1),
        'https://keys.test/k.bin': bytes(7),
      },
      (url) => seen.push(url),
    );

    const result = await assembleStream({ manifestUrl: master, http });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe('stream-hls-encrypted');
    expect(result.error.retryable).toBe(false);
    // Only the manifest was ever requested.
    expect(seen).toEqual([master]);
  });
});

describe('assembleStream: DASH', () => {
  const mpdUrl = 'https://cdn.test/dash/manifest.mpd';
  const manifest = `<MPD type="static" mediaPresentationDuration="PT8S">
    <Period duration="PT8S"><AdaptationSet mimeType="video/mp4">
      <SegmentTemplate initialization="init.m4s" media="seg-$Number$.m4s" duration="4" timescale="1"/>
      <Representation id="v" bandwidth="1000" width="1280" height="720"/>
    </AdaptationSet></Period></MPD>`;

  it('assembles the init segment plus every media segment', async () => {
    const http = stubHttp({
      [mpdUrl]: manifest,
      'https://cdn.test/dash/init.m4s': bytes(9, 3),
      'https://cdn.test/dash/seg-1.m4s': bytes(1, 5),
      'https://cdn.test/dash/seg-2.m4s': bytes(2, 5),
    });

    const result = await assembleStream({ manifestUrl: mpdUrl, http });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toMatchObject({
      kind: 'dash',
      segmentCount: 3,
      byteLength: 13,
      extension: 'mp4',
    });
  });

  it('refuses a protected manifest before requesting anything else', async () => {
    const seen: string[] = [];
    const http = stubHttp(
      {
        [mpdUrl]: manifest.replace(
          '<Representation',
          '<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/><Representation',
        ),
        'https://cdn.test/dash/init.m4s': bytes(9, 3),
      },
      (url) => seen.push(url),
    );

    const result = await assembleStream({ manifestUrl: mpdUrl, http });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe('stream-dash-encrypted');
    expect(seen).toEqual([mpdUrl]);
  });

  it('reports a live manifest as not assemblable', async () => {
    const http = stubHttp({ [mpdUrl]: manifest.replace('type="static"', 'type="dynamic"') });

    const result = await assembleStream({ manifestUrl: mpdUrl, http });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe('stream-dash-dynamic');
  });
});

describe('assembleStream: streams whose audio is a separate track (§10.6)', () => {
  it('fetches both HLS tracks and joins them into one file', async () => {
    // 1.1.0 saved the video track alone — a silent video. 1.2.0 refused it. Now both
    // tracks are fetched and muxed.
    const master = 'https://cdn.test/hls/master.m3u8';
    const seen: string[] = [];
    const http = stubHttp(
      {
        [master]: [
          '#EXTM3U',
          '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"',
          '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="aac"',
          'video/720.m3u8',
        ].join('\n'),
        'https://cdn.test/hls/video/720.m3u8': [
          '#EXTM3U',
          '#EXT-X-MAP:URI="init.mp4"',
          '#EXTINF:4,',
          'v1.m4s',
          '#EXT-X-ENDLIST',
        ].join('\n'),
        'https://cdn.test/hls/audio/en.m3u8': [
          '#EXTM3U',
          '#EXT-X-MAP:URI="init.mp4"',
          '#EXTINF:4,',
          'a1.m4s',
          '#EXT-X-ENDLIST',
        ].join('\n'),
        'https://cdn.test/hls/video/init.mp4': initSegment(1),
        'https://cdn.test/hls/video/v1.m4s': fragment(1, 1, bytesOf(0xaa)),
        'https://cdn.test/hls/audio/init.mp4': initSegment(1),
        'https://cdn.test/hls/audio/a1.m4s': fragment(1, 1, bytesOf(0xbb)),
      },
      (url) => seen.push(url),
    );

    const result = await assembleStream({ manifestUrl: master, http });

    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) {
      return;
    }
    // Both playlists were read and both tracks fetched.
    expect(seen).toContain('https://cdn.test/hls/video/720.m3u8');
    expect(seen).toContain('https://cdn.test/hls/audio/en.m3u8');
    expect(seen).toContain('https://cdn.test/hls/audio/a1.m4s');

    const file = joinBytes(...result.value.parts);
    expect(result.value.extension).toBe('mp4');
    // One movie header, and a fragment from each track with distinct ids.
    expect(readBoxes(file).filter((entry) => entry.type === 'moov')).toHaveLength(1);
    expect(trackIdsOf(file)).toEqual([1, 2]);
  });

  it('refuses a split-track stream whose renditions are MPEG-TS', async () => {
    // Joining those would mean demuxing and re-packaging, which this project does not
    // do — so it is refused with a reason rather than saved as a silent video.
    const master = 'https://cdn.test/hls/master.m3u8';
    const http = stubHttp({
      [master]: [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO="aac"',
        'video/720.m3u8',
      ].join('\n'),
      'https://cdn.test/hls/video/720.m3u8': [
        '#EXTM3U',
        '#EXTINF:4,',
        'v1.ts',
        '#EXT-X-ENDLIST',
      ].join('\n'),
      'https://cdn.test/hls/audio/en.m3u8': [
        '#EXTM3U',
        '#EXTINF:4,',
        'a1.ts',
        '#EXT-X-ENDLIST',
      ].join('\n'),
      'https://cdn.test/hls/video/v1.ts': bytesOf(1, 2, 3),
      'https://cdn.test/hls/audio/a1.ts': bytesOf(4, 5, 6),
    });

    const result = await assembleStream({ manifestUrl: master, http });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe('stream-hls-separate-audio');
    expect(result.error.messageKey).toBe('error.download.stream.tracks');
    expect(result.error.retryable).toBe(false);
  });

  it('still assembles a master whose audio is muxed into the variants', async () => {
    const master = 'https://cdn.test/hls/master.m3u8';
    const http = stubHttp({
      [master]: [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO="aac"',
        'v.m3u8',
      ].join('\n'),
      'https://cdn.test/hls/v.m3u8': ['#EXTM3U', '#EXTINF:4,', 'a.ts', '#EXT-X-ENDLIST'].join('\n'),
      'https://cdn.test/hls/a.ts': bytes(1, 8),
    });

    const result = await assembleStream({ manifestUrl: master, http });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Untouched: a single track is copied through, not run past the muxer.
    expect(result.value.extension).toBe('ts');
  });

  it('fetches both DASH tracks and joins them into one file', async () => {
    const mpdUrl = 'https://cdn.test/dash/manifest.mpd';
    const http = stubHttp({
      [mpdUrl]: `<MPD type="static" mediaPresentationDuration="PT8S"><Period duration="PT8S">
        <AdaptationSet mimeType="video/mp4"><SegmentTemplate initialization="v-init.m4s" media="v-$Number$.m4s" duration="4" timescale="1"/>
          <Representation id="v" bandwidth="2000000" width="1280" height="720"/></AdaptationSet>
        <AdaptationSet mimeType="audio/mp4"><SegmentTemplate initialization="a-init.m4s" media="a-$Number$.m4s" duration="4" timescale="1"/>
          <Representation id="a" bandwidth="128000"/></AdaptationSet>
      </Period></MPD>`,
      'https://cdn.test/dash/v-init.m4s': initSegment(1),
      'https://cdn.test/dash/v-1.m4s': fragment(1, 1, bytesOf(0x11)),
      'https://cdn.test/dash/v-2.m4s': fragment(1, 2, bytesOf(0x12)),
      'https://cdn.test/dash/a-init.m4s': initSegment(1),
      'https://cdn.test/dash/a-1.m4s': fragment(1, 1, bytesOf(0x21)),
      'https://cdn.test/dash/a-2.m4s': fragment(1, 2, bytesOf(0x22)),
    });

    const result = await assembleStream({ manifestUrl: mpdUrl, http });

    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) {
      return;
    }
    const file = joinBytes(...result.value.parts);
    expect(result.value.extension).toBe('mp4');
    expect(result.value.mimeType).toBe('video/mp4');
    // Interleaved video, audio, video, audio — with one sequence across the file.
    expect(trackIdsOf(file)).toEqual([1, 2, 1, 2]);
    expect(sequencesOf(file)).toEqual([1, 2, 3, 4]);
  });

  it('picks the highest-bandwidth representation of each track', async () => {
    const mpdUrl = 'https://cdn.test/dash/manifest.mpd';
    const seen: string[] = [];
    const http = stubHttp(
      {
        [mpdUrl]: `<MPD type="static" mediaPresentationDuration="PT4S"><Period duration="PT4S">
        <AdaptationSet mimeType="video/mp4"><SegmentTemplate initialization="$RepresentationID$-init.m4s" media="$RepresentationID$-$Number$.m4s" duration="4" timescale="1"/>
          <Representation id="vlow" bandwidth="300000"/><Representation id="vhigh" bandwidth="4000000"/></AdaptationSet>
        <AdaptationSet mimeType="audio/mp4"><SegmentTemplate initialization="$RepresentationID$-init.m4s" media="$RepresentationID$-$Number$.m4s" duration="4" timescale="1"/>
          <Representation id="alow" bandwidth="64000"/><Representation id="ahigh" bandwidth="192000"/></AdaptationSet>
      </Period></MPD>`,
        'https://cdn.test/dash/vhigh-init.m4s': initSegment(1),
        'https://cdn.test/dash/vhigh-1.m4s': fragment(1, 1, bytesOf(1)),
        'https://cdn.test/dash/ahigh-init.m4s': initSegment(1),
        'https://cdn.test/dash/ahigh-1.m4s': fragment(1, 1, bytesOf(2)),
      },
      (url) => seen.push(url),
    );

    const result = await assembleStream({ manifestUrl: mpdUrl, http });

    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    expect(seen.some((url) => url.includes('vlow'))).toBe(false);
    expect(seen.some((url) => url.includes('alow'))).toBe(false);
  });

  it('assembles a DASH manifest whose single set carries both tracks', async () => {
    const mpdUrl = 'https://cdn.test/dash/manifest.mpd';
    const http = stubHttp({
      [mpdUrl]: `<MPD type="static" mediaPresentationDuration="PT4S"><Period duration="PT4S">
        <AdaptationSet mimeType="video/mp4" codecs="avc1.640028,mp4a.40.2">
          <SegmentTemplate media="s-$Number$.m4s" duration="4" timescale="1"/>
          <Representation id="av" bandwidth="2000000"/></AdaptationSet>
      </Period></MPD>`,
      'https://cdn.test/dash/s-1.m4s': bytes(1, 8),
    });

    const result = await assembleStream({ manifestUrl: mpdUrl, http });

    expect(result.ok).toBe(true);
  });
});

describe('assembleStream: byte-range segments', () => {
  const master = 'https://cdn.test/hls/master.m3u8';
  const playlist = [
    '#EXTM3U',
    '#EXTINF:4,',
    '#EXT-X-BYTERANGE:10@0',
    'all.ts',
    '#EXTINF:4,',
    '#EXT-X-BYTERANGE:10',
    'all.ts',
    '#EXT-X-ENDLIST',
  ].join('\n');

  it('joins exactly the requested slices when the server honours Range', async () => {
    const http = stubHttp({ [master]: playlist, 'https://cdn.test/hls/all.ts': bytes(7, 40) });

    const result = await assembleStream({ manifestUrl: master, http });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.byteLength).toBe(20);
  });

  it('refuses a segment the server answered without the range', async () => {
    // The silent-corruption case: 200 and the whole 40-byte file for a 10-byte slice.
    const http = stubHttp(
      { [master]: playlist, 'https://cdn.test/hls/all.ts': bytes(7, 40) },
      undefined,
      true,
    );

    const result = await assembleStream({ manifestUrl: master, http });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe('stream-range-ignored');
  });
});

describe('assembleStream: how a refusal describes itself', () => {
  const master = 'https://cdn.test/hls/master.m3u8';

  it('classifies an encrypted stream as protected media, not as a network problem', async () => {
    const http = stubHttp({
      [master]: [
        '#EXTM3U',
        '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.test/k"',
        '#EXTINF:4,',
        'a.ts',
        '#EXT-X-ENDLIST',
      ].join('\n'),
    });

    const result = await assembleStream({ manifestUrl: master, http });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    // The user must be told the media is protected — never "check your network".
    expect(result.error.category).toBe('drm');
    expect(result.error.messageKey).toBe('error.drm');
    expect(result.error.retryable).toBe(false);
  });

  it.each([
    [
      'a live playlist',
      ['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXTINF:4,', 'a.ts'].join('\n'),
      'error.download.stream.live',
    ],
    [
      'a playlist with no segments',
      ['#EXTM3U', '#EXT-X-ENDLIST'].join('\n'),
      'error.download.stream',
    ],
  ])('gives %s its own message key', async (_label, body, messageKey) => {
    const http = stubHttp({ [master]: body });

    const result = await assembleStream({ manifestUrl: master, http });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.messageKey).toBe(messageKey);
    expect(result.error.category).toBe('network');
  });

  it('describes an oversize stream as too large', async () => {
    const http = stubHttp({
      [master]: ['#EXTM3U', '#EXTINF:4,', 'a.ts', '#EXT-X-ENDLIST'].join('\n'),
      'https://cdn.test/hls/a.ts': bytes(1, 64),
    });

    const result = await assembleStream({ manifestUrl: master, http, maxTotalBytes: 10 });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.messageKey).toBe('error.download.stream.tooLarge');
  });
});

describe('assembleStream: failure handling', () => {
  const master = 'https://cdn.test/hls/master.m3u8';
  const playlist = ['#EXTM3U', '#EXTINF:4,', 'a.ts', '#EXTINF:4,', 'b.ts', '#EXT-X-ENDLIST'].join(
    '\n',
  );

  it('rejects a URL that is not a manifest at all', async () => {
    const result = await assembleStream({
      manifestUrl: 'https://cdn.test/video.mp4',
      http: stubHttp({}),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe('stream-not-a-manifest');
  });

  it('stops at the first failed segment and keeps the retryable flag', async () => {
    const http = stubHttp({
      [master]: playlist,
      'https://cdn.test/hls/a.ts': bytes(1),
      'https://cdn.test/hls/b.ts': new NetworkError('boom', {
        code: 'http-network-failed',
        messageKey: 'error.http',
        retryable: true,
      }),
    });

    const result = await assembleStream({ manifestUrl: master, http });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe('stream-segment-failed');
    expect(result.error.message).toContain('Segment 2 of 2');
    expect(result.error.retryable).toBe(true);
  });

  it('propagates a manifest fetch failure as retryable when the transport says so', async () => {
    const http = stubHttp({
      [master]: new NetworkError('offline', {
        code: 'http-network-failed',
        messageKey: 'error.http',
        retryable: true,
      }),
    });

    const result = await assembleStream({ manifestUrl: master, http });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe('stream-manifest-fetch-failed');
    expect(result.error.retryable).toBe(true);
  });

  it('refuses to exceed the total-size ceiling', async () => {
    const http = stubHttp({
      [master]: playlist,
      'https://cdn.test/hls/a.ts': bytes(1, 64),
      'https://cdn.test/hls/b.ts': bytes(2, 64),
    });

    const result = await assembleStream({ manifestUrl: master, http, maxTotalBytes: 100 });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe('stream-too-large');
  });

  it('stops when the caller aborts', async () => {
    const controller = new AbortController();
    const http = stubHttp({
      [master]: playlist,
      'https://cdn.test/hls/a.ts': bytes(1),
      'https://cdn.test/hls/b.ts': bytes(2),
    });

    const result = await assembleStream({
      manifestUrl: master,
      http,
      signal: controller.signal,
      onProgress: (): void => {
        controller.abort();
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe('stream-aborted');
  });

  it('collects every origin the segments actually came from', async () => {
    const http = stubHttp({
      [master]: [
        '#EXTM3U',
        '#EXTINF:4,',
        'https://edge-a.test/a.ts',
        '#EXTINF:4,',
        'https://edge-b.test/b.ts',
        '#EXT-X-ENDLIST',
      ].join('\n'),
      'https://edge-a.test/a.ts': bytes(1),
      'https://edge-b.test/b.ts': bytes(2),
    });

    const result = await assembleStream({ manifestUrl: master, http });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.origins).toEqual(['https://edge-a.test/*', 'https://edge-b.test/*']);
  });
});
