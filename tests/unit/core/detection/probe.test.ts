/**
 * Detection-time resource probing (PROJECT_BIBLE.md §9.1, §14.3, ADR-012).
 *
 * The behaviour under test is the one that makes a disguised stream detectable at all:
 * a URL ending in `.txt`, served as `text/plain`, whose body is `#EXTM3U`. Equally
 * important is what the probe REFUSES to do — a detection pass must not become a burst
 * of requests at hosts the user never asked to download from.
 */
import { describe, expect, it } from 'vitest';
import type { HttpClient, HttpRequestOptions, HttpResponse } from '@platform/http';
import { createResourceProbe } from '@core/detection/probe/probe';
import {
  PROBE_MAX_MEDIA_RESULTS,
  PROBE_MAX_PER_RUN,
  type ObservedResource,
} from '@core/detection/probe';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function transportStream(): Uint8Array {
  const bytes = new Uint8Array(188 * 3).fill(0x11);
  for (let index = 0; index < 3; index += 1) {
    bytes[index * 188] = 0x47;
  }
  return bytes;
}

interface Stub {
  readonly client: HttpClient;
  /** Every URL requested, in order. */
  readonly requested: string[];
  readonly options: (HttpRequestOptions | undefined)[];
}

function stubHttp(routes: Readonly<Record<string, Uint8Array | Error>>): Stub {
  const requested: string[] = [];
  const options: (HttpRequestOptions | undefined)[] = [];
  return {
    requested,
    options,
    client: {
      get: (url: string, opts?: HttpRequestOptions): Promise<HttpResponse> => {
        requested.push(url);
        options.push(opts);
        const route = routes[url];
        if (route === undefined) {
          return Promise.reject(new Error(`404 ${url}`));
        }
        if (route instanceof Error) {
          return Promise.reject(route);
        }
        return Promise.resolve({ status: 206, ok: true, headers: {}, bytes: route, url });
      },
      getText: () => Promise.reject(new Error('not used')),
    },
  };
}

const observed = (
  url: string,
  initiatorType = 'xmlhttprequest',
  sizeBytes?: number,
): ObservedResource => ({
  url,
  initiatorType,
  ...(sizeBytes !== undefined && { sizeBytes }),
});

describe('core/detection resource probe', () => {
  const PLAYLIST = 'https://cdn.test/media/abc.txt';

  it('identifies a playlist that calls itself a text file', async () => {
    const http = stubHttp({ [PLAYLIST]: utf8('#EXTM3U\n#EXT-X-VERSION:3\n') });
    const probe = createResourceProbe({ http: http.client });

    const found = await probe.identify([observed(PLAYLIST)]);

    // The MIME reported is the one the BYTES imply, not the one the server claimed —
    // that is what lets the existing manifest detector recognise it.
    expect(found).toStrictEqual([
      { url: PLAYLIST, mimeType: 'application/vnd.apple.mpegurl', statusCode: 206 },
    ]);
  });

  it('reads only a prefix, with a plain GET rather than a Range request', async () => {
    const http = stubHttp({ [PLAYLIST]: utf8('#EXTM3U\n') });
    await createResourceProbe({ http: http.client }).identify([observed(PLAYLIST)]);

    const options = http.options[0];
    // A mislabelled 4 GB file must not be pulled into memory to find out what it is.
    expect(options?.maxBytes).toBeLessThanOrEqual(1024);
    expect(options?.truncate).toBe(true);
    // Deliberately NO Range header: `Range` is not CORS-safelisted, so cross-origin it
    // forces a preflight many hosts do not answer, and a host that ignores it answers
    // 200 with the whole body — which this client refuses. Measured against the real
    // site before choosing (ADR-012).
    expect(options?.range).toBeUndefined();
    expect(options?.timeoutMs).toBeGreaterThan(0);
  });

  it('identifies MPEG-TS, DASH and MP4 by their bytes too', async () => {
    const cases: readonly [string, Uint8Array, string][] = [
      ['https://cdn.test/a.css', transportStream(), 'video/mp2t'],
      [
        'https://cdn.test/b.txt',
        utf8('<?xml version="1.0"?><MPD type="static">'),
        'application/dash+xml',
      ],
      [
        'https://cdn.test/c.bin',
        new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]),
        'video/mp4',
      ],
    ];
    for (const [url, bytes, mime] of cases) {
      const probe = createResourceProbe({ http: stubHttp({ [url]: bytes }).client });
      const found = await probe.identify([observed(url)]);
      expect(
        found.map((r) => r.mimeType),
        url,
      ).toStrictEqual([mime]);
    }
  });

  it('reports the playlist and not its segments, once it has found one', async () => {
    // A stream is hundreds of segments. Without this rule a single video fills the
    // popup with its own fragments, and the item the user wants is buried (§4.2).
    const http = stubHttp({
      'https://cdn.test/master.txt': utf8('#EXTM3U\n'),
      'https://cdn.test/seg-1.css': transportStream(),
      'https://cdn.test/seg-2.css': transportStream(),
      'https://cdn.test/seg-3.css': transportStream(),
    });
    const probe = createResourceProbe({ http: http.client });

    const found = await probe.identify([
      observed('https://cdn.test/seg-1.css'),
      observed('https://cdn.test/master.txt'),
      observed('https://cdn.test/seg-2.css'),
      observed('https://cdn.test/seg-3.css'),
    ]);

    expect(found.map((r) => r.url)).toStrictEqual(['https://cdn.test/master.txt']);
  });

  it('reports standalone media when there is no playlist, but only a few', async () => {
    const routes: Record<string, Uint8Array> = {};
    const resources: ObservedResource[] = [];
    for (let index = 0; index < 6; index += 1) {
      const url = `https://cdn.test/clip${String(index)}.bin`;
      routes[url] = transportStream();
      resources.push(observed(url));
    }
    const probe = createResourceProbe({ http: stubHttp(routes).client });

    const found = await probe.identify(resources);

    expect(found.length).toBe(PROBE_MAX_MEDIA_RESULTS);
  });

  it('ignores resources the browser loaded as page assets', async () => {
    // A real stylesheet loaded through <link> is a stylesheet. Only script-driven
    // loads can be the playlist a MediaSource is being fed from.
    const http = stubHttp({ 'https://cdn.test/style.css': transportStream() });
    const probe = createResourceProbe({ http: http.client });

    const found = await probe.identify([
      observed('https://cdn.test/style.css', 'link'),
      observed('https://cdn.test/style.css', 'img'),
      observed('https://cdn.test/style.css', 'script'),
    ]);

    expect(found).toStrictEqual([]);
    expect(http.requested).toStrictEqual([]);
  });

  it('skips resources too large to be a manifest', async () => {
    const http = stubHttp({ 'https://cdn.test/seg.css': transportStream() });
    const probe = createResourceProbe({ http: http.client });

    await probe.identify([
      observed('https://cdn.test/seg.css', 'xmlhttprequest', 40 * 1024 * 1024),
    ]);

    // Segments are identified later, from bytes already fetched for a download the
    // user asked for — not here.
    expect(http.requested).toStrictEqual([]);
  });

  it('probes a resource of unknown size, because cross-origin timing reports zero', async () => {
    const http = stubHttp({ [PLAYLIST]: utf8('#EXTM3U\n') });
    await createResourceProbe({ http: http.client }).identify([
      { url: PLAYLIST, initiatorType: 'fetch', sizeBytes: 0 },
    ]);
    expect(http.requested).toStrictEqual([PLAYLIST]);
  });

  it('never exceeds its per-run request budget', async () => {
    const routes: Record<string, Uint8Array> = {};
    const resources: ObservedResource[] = [];
    for (let index = 0; index < 40; index += 1) {
      const url = `https://cdn.test/r${String(index)}.txt`;
      routes[url] = utf8('nothing');
      resources.push(observed(url));
    }
    const http = stubHttp(routes);

    await createResourceProbe({ http: http.client }).identify(resources);

    expect(http.requested.length).toBe(PROBE_MAX_PER_RUN);
  });

  it('remembers what it has already looked at, including the misses', async () => {
    const http = stubHttp({ [PLAYLIST]: utf8('#EXTM3U\n'), 'https://cdn.test/x.json': utf8('{}') });
    const probe = createResourceProbe({ http: http.client });

    const first = await probe.identify([observed(PLAYLIST), observed('https://cdn.test/x.json')]);
    const second = await probe.identify([observed(PLAYLIST), observed('https://cdn.test/x.json')]);

    expect(first.length).toBe(1);
    // The second pass answers from memory: a page that re-reports the same resources
    // on every mutation must not re-request them.
    expect(second).toStrictEqual(first);
    expect(http.requested).toStrictEqual([PLAYLIST, 'https://cdn.test/x.json']);
  });

  it('forgets on demand, so a new page starts clean', async () => {
    const http = stubHttp({ [PLAYLIST]: utf8('#EXTM3U\n') });
    const probe = createResourceProbe({ http: http.client });

    await probe.identify([observed(PLAYLIST)]);
    probe.forget();
    await probe.identify([observed(PLAYLIST)]);

    expect(http.requested).toStrictEqual([PLAYLIST, PLAYLIST]);
  });

  it('reports nothing and raises nothing when a probe fails', async () => {
    // A CORS rejection, a refused range, a dead host: none of these are the user's
    // problem, and detection continues on what the DOM gave it.
    const http = stubHttp({ [PLAYLIST]: new Error('CORS') });
    const probe = createResourceProbe({ http: http.client });

    await expect(probe.identify([observed(PLAYLIST)])).resolves.toStrictEqual([]);
  });

  it('falls back to the name when a manifest cannot be read at all', async () => {
    // The host answers no cross-origin request, so there are no bytes to prefer. What
    // the URL claims is all that is left, and for a playlist it is worth reporting:
    // the alternative is discarding a stream because we were not allowed to look.
    const url = 'https://cdn.test/hls/playlist.m3u8';
    const http = stubHttp({ [url]: new Error('CORS') });
    const probe = createResourceProbe({ http: http.client });

    await expect(probe.identify([observed(url)])).resolves.toStrictEqual([
      { url, mimeType: 'application/vnd.apple.mpegurl' },
    ]);
  });

  it('falls back for a DASH manifest too, and for nothing else', async () => {
    const mpd = 'https://cdn.test/dash/manifest.mpd';
    const disguised = 'https://cdn.test/media/abc.txt';
    const image = 'https://cdn.test/poster.jpg';
    const http = stubHttp({
      [mpd]: new Error('CORS'),
      [disguised]: new Error('CORS'),
      [image]: new Error('CORS'),
    });
    const probe = createResourceProbe({ http: http.client });

    // A name is a fallback for a manifest, never a substitute for bytes anywhere else:
    // the disguised case is exactly the one a name answers WRONGLY (ADR-012).
    await expect(
      probe.identify([observed(mpd), observed(disguised), observed(image)]),
    ).resolves.toStrictEqual([{ url: mpd, mimeType: 'application/dash+xml' }]);
  });

  it('prefers bytes over the name when the resource can be read', async () => {
    // A `.m3u8` that is not a playlist is still not a playlist.
    const url = 'https://cdn.test/hls/liar.m3u8';
    const http = stubHttp({ [url]: utf8('<html>not a playlist</html>') });
    const probe = createResourceProbe({ http: http.client });

    await expect(probe.identify([observed(url)])).resolves.toStrictEqual([]);
  });

  it('spends its request budget on the manifests first', async () => {
    // A page can load more candidates than the cap allows. Spending the budget in load
    // order can miss the one resource that IS the stream.
    const routes: Record<string, Uint8Array> = {};
    const resources: ObservedResource[] = [];
    for (let index = 0; index < PROBE_MAX_PER_RUN; index += 1) {
      const url = `https://cdn.test/asset-${String(index)}.json`;
      routes[url] = utf8('{}');
      resources.push(observed(url));
    }
    const playlist = 'https://cdn.test/hls/master.m3u8';
    routes[playlist] = utf8('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n');
    resources.push(observed(playlist));

    const http = stubHttp(routes);
    const probe = createResourceProbe({ http: http.client });
    const found = await probe.identify(resources);

    expect(http.requested[0]).toBe(playlist);
    expect(found.map((resource) => resource.url)).toStrictEqual([playlist]);
  });

  it('stops when detection is cancelled', async () => {
    const routes: Record<string, Uint8Array> = {};
    const resources: ObservedResource[] = [];
    for (let index = 0; index < 5; index += 1) {
      const url = `https://cdn.test/s${String(index)}.txt`;
      routes[url] = utf8('#EXTM3U\n');
      resources.push(observed(url));
    }
    const http = stubHttp(routes);
    const controller = new AbortController();
    controller.abort();

    const found = await createResourceProbe({ http: http.client }).identify(
      resources,
      controller.signal,
    );

    expect(found).toStrictEqual([]);
    expect(http.requested).toStrictEqual([]);
  });

  it('requests each distinct URL once, however often it appears', async () => {
    const http = stubHttp({ [PLAYLIST]: utf8('#EXTM3U\n') });
    await createResourceProbe({ http: http.client }).identify([
      observed(PLAYLIST),
      observed(PLAYLIST, 'fetch'),
      observed(PLAYLIST),
    ]);
    expect(http.requested).toStrictEqual([PLAYLIST]);
  });

  it('leaves non-http URLs alone', async () => {
    const http = stubHttp({});
    await createResourceProbe({ http: http.client }).identify([
      observed('blob:https://cdn.test/9d58'),
      observed('data:text/plain,#EXTM3U'),
    ]);
    expect(http.requested).toStrictEqual([]);
  });
});

describe('core/detection probe — one stream, one entry', () => {
  const MASTER = utf8('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nindex_1080p.txt\n');
  const MEDIA = utf8('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg-1.css\n');

  it('keeps the master and drops the rendition beside it', async () => {
    // A player fetches the master and then a rendition inside it, so a page yields
    // both. Two cards for one video is worse than one, and the master is the one that
    // carries every rendition for the quality chooser.
    const http = stubHttp({
      'https://cdn.test/v/master.txt': MASTER,
      'https://cdn.test/v/index_1080p.txt': MEDIA,
    });

    const found = await createResourceProbe({ http: http.client }).identify([
      observed('https://cdn.test/v/index_1080p.txt'),
      observed('https://cdn.test/v/master.txt'),
    ]);

    expect(found.map((r) => r.url)).toStrictEqual(['https://cdn.test/v/master.txt']);
  });

  it('keeps a media playlist that has no master beside it', async () => {
    // A page serving one media playlist on its own must still offer it.
    const http = stubHttp({ 'https://cdn.test/v/only.txt': MEDIA });

    const found = await createResourceProbe({ http: http.client }).identify([
      observed('https://cdn.test/v/only.txt'),
    ]);

    expect(found.map((r) => r.url)).toStrictEqual(['https://cdn.test/v/only.txt']);
  });

  it('does not let one stream suppress another stream elsewhere on the page', async () => {
    // Two unrelated streams live in different directories; a master in one says nothing
    // about a rendition in the other.
    const http = stubHttp({
      'https://cdn.test/a/master.txt': MASTER,
      'https://cdn.test/b/index.txt': MEDIA,
    });

    const found = await createResourceProbe({ http: http.client }).identify([
      observed('https://cdn.test/a/master.txt'),
      observed('https://cdn.test/b/index.txt'),
    ]);

    expect(found.map((r) => r.url).sort()).toStrictEqual([
      'https://cdn.test/a/master.txt',
      'https://cdn.test/b/index.txt',
    ]);
  });
});
