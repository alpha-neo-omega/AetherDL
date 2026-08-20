/**
 * The HTTP read adapter (PROJECT_BIBLE.md §10.6, §10.9): the only place the
 * extension's own code reaches the network, so its refusals and its ceilings matter
 * as much as its happy path. No test touches a real network.
 */
import { describe, expect, it, vi } from 'vitest';
import { HttpError, NetworkError } from '@shared/result/errors';
import {
  createHttpClient,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_HTTP_TIMEOUT_MS,
} from '@platform/http/service';

function body(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function respond(
  bytes: Uint8Array,
  init: { status?: number; headers?: Record<string, string>; url?: string } = {},
): Response {
  const status = init.status ?? 200;
  const response = new Response(status === 204 ? null : body(bytes), {
    status,
    headers: init.headers ?? {},
  });
  if (init.url !== undefined) {
    Object.defineProperty(response, 'url', { value: init.url });
  }
  return response;
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('platform/http: reading a resource', () => {
  it('returns the bytes, the status and lowercased headers', async () => {
    const fetchImpl = vi.fn(async () =>
      respond(text('#EXTM3U'), {
        headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'X-Odd-Case': 'kept' },
        url: 'https://cdn.test/final.m3u8',
      }),
    );
    const client = createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const response = await client.get('https://cdn.test/a.m3u8');

    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);
    expect(new TextDecoder().decode(response.bytes)).toBe('#EXTM3U');
    expect(response.headers['content-type']).toBe('application/vnd.apple.mpegurl');
    expect(response.headers['x-odd-case']).toBe('kept');
    // The URL after redirects, so relative manifest URIs resolve against the truth.
    expect(response.url).toBe('https://cdn.test/final.m3u8');
  });

  it('decodes text for manifests', async () => {
    const client = createHttpClient({
      fetchImpl: (async () => respond(text('#EXTM3U\n#EXT-X-ENDLIST'))) as unknown as typeof fetch,
    });

    expect(await client.getText('https://cdn.test/a.m3u8')).toBe('#EXTM3U\n#EXT-X-ENDLIST');
  });

  it('asks for a byte range in the syntax servers expect', async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(init);
      return respond(text('chunk'));
    });
    const client = createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await client.get('https://cdn.test/v.mp4', { range: { first: 0, last: 1023 } });
    await client.get('https://cdn.test/v.mp4', { range: { first: 2048 } });

    const headers = seen.map((init) => (init.headers as Record<string, string>).range);
    expect(headers).toEqual(['bytes=0-1023', 'bytes=2048-']);
    // Reads only, and never with the user's cookies attached.
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.credentials).toBe('omit');
  });

  it('refuses a range that ends before it starts', async () => {
    const client = createHttpClient({
      fetchImpl: (async () => respond(text('x'))) as unknown as typeof fetch,
    });

    await expect(
      client.get('https://cdn.test/v.mp4', { range: { first: 10, last: 4 } }),
    ).rejects.toMatchObject({ code: 'http-range-invalid' });
  });
});

describe('platform/http: refusals', () => {
  it.each([
    ['a blob URL', 'blob:https://cdn.test/1234'],
    ['a data URL', 'data:video/mp4;base64,AAAA'],
    ['a file URL', 'file:///etc/passwd'],
    ['an extension URL', 'chrome-extension://abc/popup.html'],
  ])('refuses %s before any request is made', async (_label, url) => {
    const fetchImpl = vi.fn();
    const client = createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.get(url)).rejects.toBeInstanceOf(NetworkError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a URL that is not absolute', async () => {
    const client = createHttpClient({ fetchImpl: vi.fn() as unknown as typeof fetch });
    await expect(client.get('/relative/path.m3u8')).rejects.toMatchObject({
      code: 'http-url-invalid',
    });
  });

  it('turns a 404 into a non-retryable http error', async () => {
    const client = createHttpClient({
      fetchImpl: (async () => respond(text(''), { status: 404 })) as unknown as typeof fetch,
    });

    const error = await client.get('https://cdn.test/gone.ts').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ code: 'http-404', retryable: false });
  });

  it('marks 5xx and 429 retryable so the caller may back off', async () => {
    for (const status of [500, 503, 429]) {
      const client = createHttpClient({
        fetchImpl: (async () => respond(text(''), { status })) as unknown as typeof fetch,
      });
      await expect(client.get('https://cdn.test/s.ts')).rejects.toMatchObject({
        code: `http-${String(status)}`,
        retryable: true,
      });
    }
  });

  it('reports a transport failure distinctly from an http answer', async () => {
    const client = createHttpClient({
      fetchImpl: (async () => {
        throw new TypeError('network down');
      }) as unknown as typeof fetch,
    });

    await expect(client.get('https://cdn.test/s.ts')).rejects.toMatchObject({
      code: 'http-network-failed',
      retryable: true,
    });
  });
});

describe('platform/http: cancellation and ceilings', () => {
  it('lets the caller cancel, and says so', async () => {
    const controller = new AbortController();
    const client = createHttpClient({
      fetchImpl: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        })) as unknown as typeof fetch,
    });

    const pending = client.get('https://cdn.test/s.ts', { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'http-aborted' });
  });

  it('does not even start when the caller signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) =>
      init.signal?.aborted === true
        ? Promise.reject(new DOMException('Aborted', 'AbortError'))
        : respond(text('x')),
    );
    const client = createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      client.get('https://cdn.test/s.ts', { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'http-aborted' });
  });

  it('times out on its own, distinguishably from a cancellation', async () => {
    vi.useFakeTimers();
    try {
      const client = createHttpClient({
        timeoutMs: 50,
        fetchImpl: ((_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          })) as unknown as typeof fetch,
      });

      const pending = client.get('https://cdn.test/slow.ts');
      const assertion = expect(pending).rejects.toMatchObject({
        code: 'http-timeout',
        retryable: true,
      });
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a body that declares more than the ceiling', async () => {
    const client = createHttpClient({
      maxBytes: 1024,
      fetchImpl: (async () =>
        respond(text('x'), { headers: { 'content-length': '99999' } })) as unknown as typeof fetch,
    });

    await expect(client.get('https://cdn.test/huge.ts')).rejects.toMatchObject({
      code: 'http-too-large',
    });
  });

  it('abandons a body that grows past the ceiling mid-stream', async () => {
    // No content-length, so the ceiling can only be enforced while reading.
    const client = createHttpClient({
      maxBytes: 8,
      fetchImpl: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(text('12345678'));
              controller.enqueue(text('9 over the line'));
              controller.close();
            },
          }),
        )) as unknown as typeof fetch,
    });

    await expect(client.get('https://cdn.test/unbounded.ts')).rejects.toMatchObject({
      code: 'http-too-large',
    });
  });

  it('ships defaults that bound an unconfigured client', () => {
    expect(DEFAULT_HTTP_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_MAX_RESPONSE_BYTES).toBeGreaterThan(0);
    expect(DEFAULT_MAX_RESPONSE_BYTES).toBeLessThanOrEqual(256 * 1024 * 1024);
  });
});
