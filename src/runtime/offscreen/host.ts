/**
 * Module: runtime/offscreen (assembly host)
 * Purpose: Answer `stream/assemble`, `stream/abort` and `stream/release` inside a
 *          context that has DOM APIs — the Chromium offscreen document
 *          (PROJECT_BIBLE.md §10.6, §7.4). Composition + message plumbing only.
 * Restrictions: Thin surface (§8.1). Assembly logic is core/download/stream; network
 *          access is platform/http; blob URLs are platform/objecturl. Encrypted
 *          manifests are refused by the assembler and reported as an error (§6).
 * Dependencies: platform/browser, platform/http, platform/objecturl, platform/stream,
 *              core/download/stream, shared/*.
 * Public API: StreamAssemblyHost, createStreamAssemblyHost.
 */
import { createHttpClient } from '@platform/http/service';
import type { HttpClient } from '@platform/http';
import { createObjectUrlAdapter } from '@platform/objecturl/service';
import { STREAM_PROGRESS_BROADCAST } from '@platform/stream/offscreen';
import type { StreamDelivery } from '@platform/stream';
import { createLocalStreamDelivery } from '@core/download/stream/deliver';
import { ValidationError } from '@shared/result/errors';
import type { MessageBus } from '@platform/messaging';
import { STREAM_QUALITY_PREFERENCES } from '@shared/constants';
import type {
  StreamAssembleRequest,
  StreamAssembleResult,
  StreamQualityPreference,
} from '@shared/types';
import type { Unsubscribe } from '@shared/utils';

export interface StreamAssemblyHostOptions {
  /**
   * The message bus only. An offscreen document is NOT a normal extension page: it
   * is limited to a small subset of extension APIs, so building the whole platform
   * facade here would fail on namespaces that do not exist in this context (§7.4).
   */
  readonly messaging: MessageBus;
  /** Injected in tests; defaults to the platform HTTP client. */
  readonly http?: HttpClient;
}

export interface StreamAssemblyHost {
  start(): void;
  /** Release every outstanding URL and detach handlers. */
  dispose(): Promise<void>;
}

function readRequest(payload: unknown): StreamAssembleRequest | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const manifestUrl = record['manifestUrl'];
  if (typeof manifestUrl !== 'string' || manifestUrl === '') {
    return undefined;
  }
  const maxTotalBytes = record['maxTotalBytes'];
  const requestId = record['requestId'];
  const renditionId = record['renditionId'];
  const preference = record['preference'];
  return {
    manifestUrl,
    ...(typeof maxTotalBytes === 'number' && maxTotalBytes > 0 && { maxTotalBytes }),
    ...(typeof requestId === 'string' && requestId !== '' && { requestId }),
    ...(typeof renditionId === 'string' && renditionId !== '' && { renditionId }),
    // Validated against the ratified vocabulary rather than trusted: this arrives
    // over a message boundary (§13.8), and an unknown value must not reach selection.
    ...(isQualityPreference(preference) && { preference }),
  };
}

/** Whether an untrusted value is one of the ratified quality preferences (§4.9). */
function isQualityPreference(value: unknown): value is StreamQualityPreference {
  return (
    typeof value === 'string' && (STREAM_QUALITY_PREFERENCES as readonly string[]).includes(value)
  );
}

/**
 * What an assembly is keyed by while it runs: the request id when the caller sent
 * one, the manifest URL otherwise. Keying on the URL alone let one job's cancel abort
 * another job for the same stream.
 */
function keyOf(request: StreamAssembleRequest): string {
  return request.requestId ?? request.manifestUrl;
}

function readUrl(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  const url = (payload as Record<string, unknown>)['url'];
  return typeof url === 'string' && url !== '' ? url : undefined;
}

export function createStreamAssemblyHost(options: StreamAssemblyHostOptions): StreamAssemblyHost {
  const bus = options.messaging;
  const delivery = createLocalStreamDelivery({
    http: options.http ?? createHttpClient(),
    objectUrl: createObjectUrlAdapter(),
  });
  // Held so a later `stream/release` can revoke exactly what it was given, and so
  // dispose() cannot leak a stream-sized blob (§8.9, §12.1).
  const held = new Map<string, StreamDelivery>();
  const running = new Map<string, AbortController>();
  const unsubscribes: Unsubscribe[] = [];
  let started = false;

  const assemble = async (payload: unknown): Promise<StreamAssembleResult> => {
    const request = readRequest(payload);
    if (request === undefined) {
      // Untrusted payload (§13.8): rejected outright, never guessed at.
      throw new ValidationError('An assembly request needs a manifest URL', {
        code: 'stream-request-invalid',
        messageKey: 'error.validation',
      });
    }
    const controller = new AbortController();
    const key = keyOf(request);
    running.set(key, controller);
    try {
      const result = await delivery.assemble({
        manifestUrl: request.manifestUrl,
        signal: controller.signal,
        ...(request.maxTotalBytes !== undefined && { maxTotalBytes: request.maxTotalBytes }),
        ...(request.renditionId !== undefined && { renditionId: request.renditionId }),
        ...(request.preference !== undefined && { preference: request.preference }),
        onProgress: (progress): void => {
          void bus.broadcast(STREAM_PROGRESS_BROADCAST, {
            manifestUrl: request.manifestUrl,
            ...(request.requestId !== undefined && { requestId: request.requestId }),
            ...progress,
          });
        },
      });
      held.set(result.url, result);
      return {
        url: result.url,
        byteLength: result.byteLength,
        extension: result.extension,
        mimeType: result.mimeType,
        segmentCount: result.segmentCount,
        origins: result.origins,
      };
    } finally {
      running.delete(key);
    }
  };

  const release = async (payload: unknown): Promise<void> => {
    const url = readUrl(payload);
    if (url === undefined) {
      return;
    }
    const delivered = held.get(url);
    held.delete(url);
    await delivered?.release();
  };

  return {
    start(): void {
      // Idempotent, like every other surface: registering twice is a wiring error the
      // message bus now refuses outright.
      if (started) {
        return;
      }
      started = true;
      unsubscribes.push(
        // Registered FIRST: it is what tells the service worker this context is
        // listening at all (see `stream/ready`).
        bus.on('stream/ready', () => true),
        bus.on('stream/assemble', assemble),
        bus.on('stream/release', release),
        bus.on('stream/abort', (payload) => {
          const request = readRequest(payload);
          if (request !== undefined) {
            running.get(keyOf(request))?.abort();
          }
        }),
      );
    },
    async dispose(): Promise<void> {
      for (const controller of running.values()) {
        controller.abort();
      }
      running.clear();
      for (const delivered of held.values()) {
        await delivered.release();
      }
      held.clear();
      for (const unsubscribe of unsubscribes.splice(0)) {
        unsubscribe();
      }
      started = false;
    },
  };
}
