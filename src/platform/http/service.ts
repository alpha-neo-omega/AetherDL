/**
 * Module: platform/http (implementation)
 * Purpose: The fetch-backed HTTP read adapter (PROJECT_BIBLE.md §10.6). This file is
 *          the single place in the extension permitted to call `fetch`; the security
 *          gate allowlists it here and nowhere else.
 * Restrictions: Platform layer. GET only, no credentials, no cookies, no redirect
 *          following beyond the platform default, `http(s)` only, and every response
 *          bounded by a byte ceiling so a hostile server cannot exhaust memory
 *          (§10.9). Retry is the caller's business (§10.4).
 * Dependencies: shared/result (error taxonomy), platform/http (contract).
 * Public API: HttpClientDeps, DEFAULT_HTTP_TIMEOUT_MS, DEFAULT_MAX_RESPONSE_BYTES,
 *          createHttpClient.
 */
import { HttpError, NetworkError } from '@shared/result/errors';
import type { HttpClient, HttpRequestOptions, HttpResponse } from '@platform/http';

/** Per-request budget: enough for a slow segment, short enough to fail visibly. */
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

/**
 * Ceiling for one response. Manifests are kilobytes and segments are a few
 * megabytes; anything past this is refused rather than buffered (§10.9).
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export interface HttpClientDeps {
  /** Injectable for tests; defaults to the platform `fetch`. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

function refuse(message: string, code: string, url: string): NetworkError {
  return new NetworkError(message, {
    code,
    messageKey: 'error.network',
    retryable: false,
    context: { url },
  });
}

/** Only http(s) may be fetched: no `file:`, `blob:`, `data:` or extension URLs. */
function requireHttpUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw refuse('Not a valid absolute URL', 'http-url-invalid', url);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw refuse(`Scheme "${parsed.protocol}" is not fetchable`, 'http-scheme-refused', url);
  }
  return parsed;
}

function rangeHeader(options: HttpRequestOptions | undefined): Readonly<Record<string, string>> {
  const range = options?.range;
  if (range === undefined) {
    return {};
  }
  const first = Math.max(0, Math.floor(range.first));
  const last = range.last === undefined ? undefined : Math.floor(range.last);
  if (last !== undefined && last < first) {
    throw refuse('Byte range ends before it starts', 'http-range-invalid', '');
  }
  return { range: `bytes=${String(first)}-${last === undefined ? '' : String(last)}` };
}

function lowercaseHeaders(headers: Headers): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
}

/**
 * Read the body with the ceiling enforced as it arrives, so an oversized resource is
 * abandoned mid-stream instead of after it has already been held in memory.
 */
async function readBounded(response: Response, maxBytes: number, url: string): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    throw new HttpError(
      `Response declares ${declared} bytes, over the ${String(maxBytes)} ceiling`,
      {
        code: 'http-too-large',
        messageKey: 'error.network',
        context: { url, declared, maxBytes },
      },
    );
  }

  const body = response.body;
  if (body === null) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new HttpError('Response exceeded the size ceiling', {
        code: 'http-too-large',
        messageKey: 'error.network',
        context: { url, maxBytes },
      });
    }
    return buffer;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value !== undefined) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new HttpError('Response exceeded the size ceiling', {
          code: 'http-too-large',
          messageKey: 'error.network',
          context: { url, maxBytes },
        });
      }
      chunks.push(value);
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createHttpClient(deps: HttpClientDeps = {}): HttpClient {
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const defaultTimeout = deps.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const defaultMaxBytes = deps.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  const get = async (url: string, options?: HttpRequestOptions): Promise<HttpResponse> => {
    requireHttpUrl(url);
    const maxBytes = options?.maxBytes ?? defaultMaxBytes;
    const timeoutMs = options?.timeoutMs ?? defaultTimeout;

    // The client's timeout and the caller's cancellation both have to be able to end
    // the request, so they are composed into one controller.
    const controller = new AbortController();
    const onCallerAbort = (): void => {
      controller.abort();
    };
    const callerSignal = options?.signal;
    if (callerSignal !== undefined) {
      if (callerSignal.aborted) {
        controller.abort();
      } else {
        callerSignal.addEventListener('abort', onCallerAbort, { once: true });
      }
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'follow',
        headers: rangeHeader(options),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new HttpError(`Request answered ${String(response.status)}`, {
          code: `http-${String(response.status)}`,
          messageKey: 'error.network',
          // 5xx and 429 are worth another attempt; the caller decides (§10.4).
          retryable: response.status >= 500 || response.status === 429,
          context: { url, status: response.status },
        });
      }

      const bytes = await readBounded(response, maxBytes, url);
      return {
        status: response.status,
        ok: true,
        headers: lowercaseHeaders(response.headers),
        bytes,
        url: response.url === '' ? url : response.url,
      };
    } catch (cause) {
      if (cause instanceof HttpError || cause instanceof NetworkError) {
        throw cause;
      }
      if (timedOut) {
        throw new NetworkError(`Request exceeded ${String(timeoutMs)}ms`, {
          code: 'http-timeout',
          messageKey: 'error.network',
          retryable: true,
          context: { url, timeoutMs },
        });
      }
      if (controller.signal.aborted) {
        throw refuse('Request was cancelled', 'http-aborted', url);
      }
      throw new NetworkError('Request could not be completed', {
        code: 'http-network-failed',
        messageKey: 'error.network',
        retryable: true,
        cause,
        context: { url },
      });
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  };

  return {
    get,
    async getText(url: string, options?: HttpRequestOptions): Promise<string> {
      const response = await get(url, options);
      return new TextDecoder('utf-8').decode(response.bytes);
    },
  };
}
