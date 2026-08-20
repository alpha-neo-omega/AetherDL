/**
 * Stream assembly (PROJECT_BIBLE.md §10.6, §6). Assembly performs no I/O of its own:
 * every test drives it with a stub HttpClient, which also proves the domain layer
 * never reaches for a browser global.
 */
import { describe, expect, it, vi } from 'vitest';
import { HttpError, NetworkError } from '@shared/result/errors';
import type { HttpClient, HttpRequestOptions, HttpResponse } from '@platform/http';
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

describe('assembleStream: streams whose audio is a separate track', () => {
  it('refuses an HLS master whose chosen variant has no audio of its own', async () => {
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
      },
      (url) => seen.push(url),
    );

    const result = await assembleStream({ manifestUrl: master, http });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe('stream-hls-separate-audio');
    expect(result.error.retryable).toBe(false);
    // Refused at the master: the variant playlist is never even read.
    expect(seen).toEqual([master]);
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
  });

  it('refuses a DASH manifest that splits audio and video across AdaptationSets', async () => {
    const mpdUrl = 'https://cdn.test/dash/manifest.mpd';
    const http = stubHttp({
      [mpdUrl]: `<MPD type="static" mediaPresentationDuration="PT8S"><Period duration="PT8S">
        <AdaptationSet mimeType="video/mp4"><SegmentTemplate media="v-$Number$.m4s" duration="4" timescale="1"/>
          <Representation id="v" bandwidth="2000000" width="1280" height="720"/></AdaptationSet>
        <AdaptationSet mimeType="audio/mp4"><SegmentTemplate media="a-$Number$.m4s" duration="4" timescale="1"/>
          <Representation id="a" bandwidth="128000"/></AdaptationSet>
      </Period></MPD>`,
    });

    const result = await assembleStream({ manifestUrl: mpdUrl, http });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe('stream-dash-separate-audio');
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
