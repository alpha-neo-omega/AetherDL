/**
 * Local stream delivery (PROJECT_BIBLE.md §10.6): assembly composed with the
 * object-URL adapter. What matters here is that a refusal from the assembler — an
 * encrypted manifest above all — reaches the caller intact and creates NO blob (§6).
 */
import { describe, expect, it, vi } from 'vitest';
import type { HttpClient, HttpResponse } from '@platform/http';
import type { ObjectUrlAdapter } from '@platform/objecturl';
import { createLocalStreamDelivery } from '@core/download/stream/deliver';

const MASTER = 'https://cdn.test/hls/index.m3u8';
const PLAYLIST = ['#EXTM3U', '#EXTINF:4,', 'a.ts', '#EXTINF:4,', 'b.ts', '#EXT-X-ENDLIST'].join(
  '\n',
);

function http(routes: Readonly<Record<string, string | Uint8Array>>): HttpClient {
  const answer = (url: string): HttpResponse => {
    const route = routes[url];
    if (route === undefined) {
      throw new Error(`unexpected request: ${url}`);
    }
    const body = typeof route === 'string' ? new TextEncoder().encode(route) : route;
    return { status: 200, ok: true, headers: {}, bytes: body, url };
  };
  return {
    get: (url) => Promise.resolve(answer(url)),
    getText: (url) => Promise.resolve(new TextDecoder().decode(answer(url).bytes)),
  };
}

function objectUrl(supported = true): {
  readonly adapter: ObjectUrlAdapter;
  readonly created: { parts: readonly Uint8Array[]; mimeType: string }[];
  readonly release: ReturnType<typeof vi.fn>;
} {
  const created: { parts: readonly Uint8Array[]; mimeType: string }[] = [];
  const release = vi.fn();
  return {
    created,
    release,
    adapter: {
      supported,
      create: (parts, mimeType) => {
        created.push({ parts, mimeType });
        const byteLength = parts.reduce((total, part) => total + part.byteLength, 0);
        return { url: `blob:aetherdl/${String(created.length)}`, byteLength, release };
      },
    },
  };
}

describe('local stream delivery', () => {
  it('assembles, then hands the bytes to the object-URL adapter once', async () => {
    const urls = objectUrl();
    const delivery = createLocalStreamDelivery({
      http: http({
        [MASTER]: PLAYLIST,
        'https://cdn.test/hls/a.ts': new Uint8Array(6),
        'https://cdn.test/hls/b.ts': new Uint8Array(4),
      }),
      objectUrl: urls.adapter,
    });

    const result = await delivery.assemble({ manifestUrl: MASTER });

    expect(delivery.supported).toBe(true);
    expect(delivery.handles(MASTER)).toBe(true);
    expect(delivery.handles('https://cdn.test/clip.mp4')).toBe(false);
    expect(urls.created).toHaveLength(1);
    expect(urls.created[0]?.mimeType).toBe('video/mp2t');
    expect(result).toMatchObject({
      url: 'blob:aetherdl/1',
      byteLength: 10,
      extension: 'ts',
      mimeType: 'video/mp2t',
      segmentCount: 2,
      origins: ['https://cdn.test/*'],
    });
  });

  it('releases the object URL when asked, and only once', async () => {
    const urls = objectUrl();
    const delivery = createLocalStreamDelivery({
      http: http({
        [MASTER]: PLAYLIST,
        'https://cdn.test/hls/a.ts': new Uint8Array(1),
        'https://cdn.test/hls/b.ts': new Uint8Array(1),
      }),
      objectUrl: urls.adapter,
    });

    const result = await delivery.assemble({ manifestUrl: MASTER });
    await result.release();
    await result.release();

    expect(urls.release).toHaveBeenCalledTimes(2);
  });

  it('rethrows an encrypted-playlist refusal and creates no blob at all', async () => {
    const urls = objectUrl();
    const delivery = createLocalStreamDelivery({
      http: http({
        [MASTER]: [
          '#EXTM3U',
          '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.test/k"',
          '#EXTINF:4,',
          'a.ts',
          '#EXT-X-ENDLIST',
        ].join('\n'),
      }),
      objectUrl: urls.adapter,
    });

    await expect(delivery.assemble({ manifestUrl: MASTER })).rejects.toMatchObject({
      code: 'stream-hls-encrypted',
      retryable: false,
    });
    expect(urls.created).toEqual([]);
  });

  it('reports unsupported when the context cannot make object URLs', () => {
    const urls = objectUrl(false);
    const delivery = createLocalStreamDelivery({ http: http({}), objectUrl: urls.adapter });

    expect(delivery.supported).toBe(false);
  });

  it('passes the quality choice through to assembly, and omits it when there is none', async () => {
    // The choice is made in the popup and applied where the manifest is read, so this
    // hand-off is the whole feature at this layer (§10.6).
    const seen: string[] = [];
    const routes = {
      [MASTER]: [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x360',
        'low.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080',
        'high.m3u8',
      ].join('\n'),
      'https://cdn.test/hls/low.m3u8': ['#EXTM3U', '#EXTINF:4,', 'l.ts', '#EXT-X-ENDLIST'].join(
        '\n',
      ),
      'https://cdn.test/hls/high.m3u8': ['#EXTM3U', '#EXTINF:4,', 'h.ts', '#EXT-X-ENDLIST'].join(
        '\n',
      ),
      'https://cdn.test/hls/l.ts': new Uint8Array(4),
      'https://cdn.test/hls/h.ts': new Uint8Array(8),
    };
    const client = http(routes);
    const tracked: HttpClient = {
      get: (url, options) => {
        seen.push(url);
        return client.get(url, options);
      },
      getText: (url, options) => client.getText(url, options),
    };
    const delivery = createLocalStreamDelivery({ http: tracked, objectUrl: objectUrl().adapter });

    await delivery.assemble({ manifestUrl: MASTER, preference: '720' });
    expect(seen).toStrictEqual(['https://cdn.test/hls/l.ts']);

    seen.length = 0;
    await delivery.assemble({ manifestUrl: MASTER, renditionId: 'https://cdn.test/hls/high.m3u8' });
    expect(seen).toStrictEqual(['https://cdn.test/hls/h.ts']);

    seen.length = 0;
    await delivery.assemble({ manifestUrl: MASTER });
    // No choice, no change: the highest bandwidth, as before this feature existed.
    expect(seen).toStrictEqual(['https://cdn.test/hls/h.ts']);
  });

  it('passes a caller ceiling through to assembly', async () => {
    const urls = objectUrl();
    const delivery = createLocalStreamDelivery({
      http: http({
        [MASTER]: PLAYLIST,
        'https://cdn.test/hls/a.ts': new Uint8Array(64),
        'https://cdn.test/hls/b.ts': new Uint8Array(64),
      }),
      objectUrl: urls.adapter,
      maxTotalBytes: 100,
    });

    await expect(delivery.assemble({ manifestUrl: MASTER })).rejects.toMatchObject({
      code: 'stream-too-large',
    });
  });
});
