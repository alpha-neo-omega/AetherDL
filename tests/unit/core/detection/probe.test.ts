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
