/**
 * The offscreen assembly host (PROJECT_BIBLE.md §10.6, §13.8). It answers three
 * messages and must: validate an untrusted payload, broadcast progress, abort on
 * request, and never leave a blob URL behind when it is torn down (§8.9, §12.1).
 */
import { describe, expect, it, vi } from 'vitest';
import type { HttpClient, HttpResponse } from '@platform/http';
import type { MessageBus } from '@platform/messaging';
import { STREAM_PROGRESS_BROADCAST } from '@platform/stream/offscreen';
import { createStreamAssemblyHost } from '@runtime/offscreen/host';

const MASTER = 'https://cdn.test/hls/index.m3u8';
const PLAYLIST = ['#EXTM3U', '#EXTINF:4,', 'a.ts', '#EXTINF:4,', 'b.ts', '#EXT-X-ENDLIST'].join(
  '\n',
);

type Handler = (payload: unknown) => unknown;

function harness(routes: Readonly<Record<string, string | Uint8Array>> = {}): {
  readonly messaging: MessageBus;
  readonly http: HttpClient;
  readonly handlers: Map<string, Handler>;
  readonly broadcasts: { type: string; payload: unknown }[];
  readonly revoked: string[];
  readonly unsubscribed: () => number;
} {
  const handlers = new Map<string, Handler>();
  const broadcasts: { type: string; payload: unknown }[] = [];
  const revoked: string[] = [];
  let unsubscribes = 0;

  const answer = (url: string): HttpResponse => {
    const route = routes[url];
    if (route === undefined) {
      throw new Error(`unexpected request: ${url}`);
    }
    const body = typeof route === 'string' ? new TextEncoder().encode(route) : route;
    return { status: 200, ok: true, headers: {}, bytes: body, url };
  };

  // The document's own globals: a page HAS object URLs, which is the entire reason
  // this surface exists.
  let counter = 0;
  const scope = globalThis as unknown as {
    URL: { createObjectURL?: unknown; revokeObjectURL?: unknown };
  };
  scope.URL.createObjectURL = (): string => {
    counter += 1;
    return `blob:aetherdl/${String(counter)}`;
  };
  scope.URL.revokeObjectURL = (url: string): void => {
    revoked.push(url);
  };

  return {
    handlers,
    broadcasts,
    revoked,
    unsubscribed: () => unsubscribes,
    http: {
      get: (url) => Promise.resolve(answer(url)),
      getText: (url) => Promise.resolve(new TextDecoder().decode(answer(url).bytes)),
    },
    messaging: {
      on: (type: string, handler: Handler) => {
        handlers.set(type, handler);
        return () => {
          unsubscribes += 1;
        };
      },
      broadcast: (type: string, payload: unknown): Promise<void> => {
        broadcasts.push({ type, payload });
        return Promise.resolve();
      },
    } as unknown as MessageBus,
  };
}

describe('offscreen assembly host', () => {
  it('assembles on request and answers with a local URL', async () => {
    const h = harness({
      [MASTER]: PLAYLIST,
      'https://cdn.test/hls/a.ts': new Uint8Array(6),
      'https://cdn.test/hls/b.ts': new Uint8Array(4),
    });
    const host = createStreamAssemblyHost({ messaging: h.messaging, http: h.http });
    host.start();

    const result = await h.handlers.get('stream/assemble')?.({ manifestUrl: MASTER });

    expect(result).toMatchObject({
      byteLength: 10,
      extension: 'ts',
      mimeType: 'video/mp2t',
      segmentCount: 2,
      origins: ['https://cdn.test/*'],
    });
    expect(String((result as { url: string }).url)).toContain('blob:');
  });

  it('broadcasts progress as segments land, tagged with the manifest', async () => {
    const h = harness({
      [MASTER]: PLAYLIST,
      'https://cdn.test/hls/a.ts': new Uint8Array(8),
      'https://cdn.test/hls/b.ts': new Uint8Array(8),
    });
    const host = createStreamAssemblyHost({ messaging: h.messaging, http: h.http });
    host.start();

    await h.handlers.get('stream/assemble')?.({ manifestUrl: MASTER });

    expect(h.broadcasts).toEqual([
      {
        type: STREAM_PROGRESS_BROADCAST,
        payload: { manifestUrl: MASTER, segmentsDone: 1, segmentsTotal: 2, bytesReceived: 8 },
      },
      {
        type: STREAM_PROGRESS_BROADCAST,
        payload: { manifestUrl: MASTER, segmentsDone: 2, segmentsTotal: 2, bytesReceived: 16 },
      },
    ]);
  });

  it('revokes exactly the URL a release names', async () => {
    const h = harness({
      [MASTER]: PLAYLIST,
      'https://cdn.test/hls/a.ts': new Uint8Array(1),
      'https://cdn.test/hls/b.ts': new Uint8Array(1),
    });
    const host = createStreamAssemblyHost({ messaging: h.messaging, http: h.http });
    host.start();

    const result = (await h.handlers.get('stream/assemble')?.({ manifestUrl: MASTER })) as {
      url: string;
    };
    await h.handlers.get('stream/release')?.({ url: result.url });

    expect(h.revoked).toEqual([result.url]);
  });

  it('applies the quality choice it was sent across the boundary', async () => {
    // The choice is made in the popup; the manifest is read here. If this hand-off
    // drops it, the user's pick silently does nothing on Chromium (§10.6, §20.5).
    const seen: string[] = [];
    const h = harness({
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
      'https://cdn.test/hls/l.ts': new Uint8Array(2),
      'https://cdn.test/hls/h.ts': new Uint8Array(8),
    });
    const tracked = {
      get: (url: string) => {
        seen.push(url);
        return h.http.get(url);
      },
      getText: (url: string) => h.http.getText(url),
    };
    const host = createStreamAssemblyHost({ messaging: h.messaging, http: tracked });
    host.start();

    await h.handlers.get('stream/assemble')?.({ manifestUrl: MASTER, preference: '720' });
    expect(seen).toStrictEqual(['https://cdn.test/hls/l.ts']);

    seen.length = 0;
    await h.handlers.get('stream/assemble')?.({
      manifestUrl: MASTER,
      renditionId: 'https://cdn.test/hls/high.m3u8',
      // An unknown preference must not reach selection: it arrived over a message
      // boundary and is validated against the ratified vocabulary (§13.8, §4.9).
      preference: 'ultra',
    });
    expect(seen).toStrictEqual(['https://cdn.test/hls/h.ts']);
  });

  it('refuses a payload that carries no manifest URL (§13.8)', async () => {
    const h = harness();
    const host = createStreamAssemblyHost({ messaging: h.messaging, http: h.http });
    host.start();

    await expect(h.handlers.get('stream/assemble')?.({ nope: 1 })).rejects.toMatchObject({
      code: 'stream-request-invalid',
    });
    await expect(h.handlers.get('stream/assemble')?.(undefined)).rejects.toMatchObject({
      code: 'stream-request-invalid',
    });
  });

  it('ignores a release for a URL it never handed out', async () => {
    const h = harness();
    const host = createStreamAssemblyHost({ messaging: h.messaging, http: h.http });
    host.start();

    await h.handlers.get('stream/release')?.({ url: 'blob:someone-elses' });
    await h.handlers.get('stream/release')?.({});

    expect(h.revoked).toEqual([]);
  });

  it('aborts a running assembly when told to, and frees nothing it never made', async () => {
    let resolveSecond: ((response: HttpResponse) => void) | undefined;
    const h = harness({ [MASTER]: PLAYLIST });
    const http: HttpClient = {
      getText: () => Promise.resolve(PLAYLIST),
      get: (url) => {
        if (url.endsWith('a.ts')) {
          return Promise.resolve({
            status: 200,
            ok: true,
            headers: {},
            bytes: new Uint8Array(2),
            url,
          });
        }
        return new Promise<HttpResponse>((resolve) => {
          resolveSecond = resolve;
        });
      },
    };
    const host = createStreamAssemblyHost({ messaging: h.messaging, http });
    host.start();

    const pending = h.handlers.get('stream/assemble')?.({ manifestUrl: MASTER });
    // Let the first segment land so the abort arrives mid-assembly.
    await vi.waitFor(() => {
      expect(h.broadcasts.length).toBeGreaterThan(0);
    });
    await h.handlers.get('stream/abort')?.({ manifestUrl: MASTER });
    resolveSecond?.({ status: 200, ok: true, headers: {}, bytes: new Uint8Array(2), url: 'x' });

    await expect(pending).rejects.toMatchObject({ code: 'stream-aborted' });
    expect(h.revoked).toEqual([]);
  });

  it('aborts the request it was asked to, not another job for the same stream', async () => {
    const resolvers: ((response: HttpResponse) => void)[] = [];
    const h = harness();
    const http: HttpClient = {
      getText: () => Promise.resolve(PLAYLIST),
      get: (url) =>
        url.endsWith('a.ts')
          ? Promise.resolve({
              status: 200,
              ok: true,
              headers: {},
              bytes: new Uint8Array(2),
              url,
            })
          : new Promise<HttpResponse>((resolve) => {
              resolvers.push(resolve);
            }),
    };
    const host = createStreamAssemblyHost({ messaging: h.messaging, http });
    host.start();

    // Two jobs, same manifest URL, different request ids.
    const first = h.handlers.get('stream/assemble')?.({
      manifestUrl: MASTER,
      requestId: 'req-1',
    }) as Promise<unknown>;
    const second = h.handlers.get('stream/assemble')?.({
      manifestUrl: MASTER,
      requestId: 'req-2',
    }) as Promise<unknown>;
    await vi.waitFor(() => {
      expect(resolvers.length).toBeGreaterThanOrEqual(2);
    });

    await h.handlers.get('stream/abort')?.({ manifestUrl: MASTER, requestId: 'req-2' });
    for (const resolve of resolvers) {
      resolve({ status: 200, ok: true, headers: {}, bytes: new Uint8Array(2), url: 'x' });
    }

    await expect(second).rejects.toMatchObject({ code: 'stream-aborted' });
    // The other job is untouched.
    await expect(first).resolves.toMatchObject({ segmentCount: 2 });
  });

  it('tags its progress broadcasts with the request id it was given', async () => {
    const h = harness({
      [MASTER]: PLAYLIST,
      'https://cdn.test/hls/a.ts': new Uint8Array(4),
      'https://cdn.test/hls/b.ts': new Uint8Array(4),
    });
    const host = createStreamAssemblyHost({ messaging: h.messaging, http: h.http });
    host.start();

    await h.handlers.get('stream/assemble')?.({ manifestUrl: MASTER, requestId: 'req-9' });

    expect(
      h.broadcasts.every(
        (message) => (message.payload as { requestId?: string }).requestId === 'req-9',
      ),
    ).toBe(true);
  });

  it('releases every held URL and detaches its handlers on dispose', async () => {
    const h = harness({
      [MASTER]: PLAYLIST,
      'https://cdn.test/hls/a.ts': new Uint8Array(1),
      'https://cdn.test/hls/b.ts': new Uint8Array(1),
    });
    const host = createStreamAssemblyHost({ messaging: h.messaging, http: h.http });
    host.start();

    const result = (await h.handlers.get('stream/assemble')?.({ manifestUrl: MASTER })) as {
      url: string;
    };
    await host.dispose();

    expect(h.revoked).toEqual([result.url]);
    expect(h.unsubscribed()).toBe(4);
  });
});

describe('offscreen host: starting twice', () => {
  it('is idempotent, rather than claiming its messages a second time', () => {
    // The bus refuses a duplicate handler, so a surface that can be started twice
    // would throw on the second call instead of simply being already started.
    const h = harness();
    const host = createStreamAssemblyHost({ messaging: h.messaging, http: h.http });

    host.start();
    expect(() => {
      host.start();
    }).not.toThrow();
  });
});
