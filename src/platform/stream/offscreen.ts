/**
 * Module: platform/stream (Chromium offscreen client)
 * Purpose: Give a Chromium MV3 service worker a {@link StreamDeliveryAdapter}
 *          (PROJECT_BIBLE.md §10.6, §7.4). A service worker has no `Blob` URL
 *          factory and no DOM, so assembly runs in an offscreen document and this
 *          client only ever exchanges small messages with it: a manifest URL out,
 *          a local URL back.
 * Restrictions: Platform layer — adapts only; depends on sibling platform contracts
 *          and shared/ (§8.4). Refusals (encryption above all) are produced by the
 *          assembly host and passed through untouched (§6, ADR-005).
 * Dependencies: platform/browser (webext types), platform/messaging, platform/stream,
 *          shared/result, shared/types.
 * Public API: OFFSCREEN_DOCUMENT_PATH, STREAM_PROGRESS_BROADCAST,
 *          OffscreenStreamDeliveryOptions, createOffscreenStreamDelivery.
 */
import type { WebExtApi } from '@platform/browser/webext';
import type { MessageBus } from '@platform/messaging';
import type {
  StreamDelivery,
  StreamDeliveryAdapter,
  StreamDeliveryRequest,
} from '@platform/stream';
import { RuntimeError } from '@shared/result/errors';
import type { StreamProgressBroadcast } from '@shared/types';
import { manifestTypeFromUrl } from '@shared/utils';

/** The offscreen page the build emits; also the document's identity to Chromium. */
export const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
export const STREAM_PROGRESS_BROADCAST = 'stream:progress';

/**
 * Assembly is a long transfer, not a UI round trip: it must not inherit the bus's
 * short default timeout. The ceiling only exists so a wedged host cannot pin a job
 * in `preparing` forever.
 */
const ASSEMBLE_TIMEOUT_MS = 30 * 60 * 1000;
const RELEASE_TIMEOUT_MS = 10_000;
/**
 * `createDocument` resolves before the document's module script has run, so the host
 * may not be listening yet. Work sent into that gap would come back as "no response",
 * which is why readiness is polled first rather than assumed.
 */
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 50;

export interface OffscreenStreamDeliveryOptions {
  readonly api: WebExtApi;
  readonly messaging: MessageBus;
  readonly maxTotalBytes?: number;
}

function isProgress(payload: unknown): payload is StreamProgressBroadcast {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  const record = payload as Record<string, unknown>;
  return (
    typeof record['manifestUrl'] === 'string' &&
    typeof record['segmentsDone'] === 'number' &&
    typeof record['segmentsTotal'] === 'number' &&
    typeof record['bytesReceived'] === 'number'
  );
}

export function createOffscreenStreamDelivery(
  options: OffscreenStreamDeliveryOptions,
): StreamDeliveryAdapter {
  const offscreen = options.api.offscreen;
  // Deliveries still holding bytes. The document stays open while any is alive, and
  // closing it is what finally frees a stream the size of a film (§12.1, §8.9).
  const live = new Set<string>();
  let opening: Promise<void> | undefined;

  const ensureDocument = async (): Promise<void> => {
    if (offscreen === undefined) {
      throw new RuntimeError('This browser has no offscreen document API', {
        code: 'stream-offscreen-unavailable',
        messageKey: 'error.runtime',
      });
    }
    if (opening !== undefined) {
      return opening;
    }
    opening = (async (): Promise<void> => {
      if (offscreen.hasDocument !== undefined && (await offscreen.hasDocument())) {
        return;
      }
      try {
        await offscreen.createDocument({
          url: OFFSCREEN_DOCUMENT_PATH,
          // BLOBS is the reason that matches what the document does: build a blob
          // from bytes it fetched. No audio, no clipboard, no scraping.
          reasons: ['BLOBS'],
          justification:
            'Assemble the segments of a stream the user chose to download into one local file.',
        });
      } catch (cause) {
        // A concurrent creation is a race, not a failure: the document we need
        // exists either way. Anything else is real.
        const message = cause instanceof Error ? cause.message : String(cause);
        if (!message.includes('Only a single offscreen')) {
          throw new RuntimeError('The assembly document could not be opened', {
            code: 'stream-offscreen-open-failed',
            messageKey: 'error.runtime',
            cause,
          });
        }
      }
    })();
    try {
      await opening;
    } finally {
      opening = undefined;
    }
  };

  /** Wait until the assembly host answers, or give up with a reportable error. */
  const awaitHost = async (): Promise<void> => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      try {
        if (await options.messaging.send('stream/ready', undefined, { timeoutMs: 1_000 })) {
          return;
        }
      } catch {
        // No listener yet (or the probe timed out): that is what polling is for.
      }
      if (Date.now() >= deadline) {
        throw new RuntimeError('The assembly document did not start', {
          code: 'stream-offscreen-not-ready',
          messageKey: 'error.runtime',
        });
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, READY_POLL_MS);
      });
    }
  };

  const closeIfIdle = async (): Promise<void> => {
    if (live.size > 0 || offscreen === undefined) {
      return;
    }
    try {
      await offscreen.closeDocument();
    } catch {
      // Already closed, or closing while another delivery reopened it. Either way
      // there is nothing to recover: the next assembly opens it again.
    }
  };

  return {
    supported: offscreen !== undefined,
    handles(url: string): boolean {
      const manifest = manifestTypeFromUrl(url);
      return manifest === 'hls' || manifest === 'dash';
    },
    async assemble(request: StreamDeliveryRequest): Promise<StreamDelivery> {
      await ensureDocument();
      try {
        await awaitHost();
      } catch (cause) {
        // A document that never started listening is useless and must not be left
        // open: it would hold a renderer for nothing and block the next attempt.
        await closeIfIdle();
        throw cause;
      }

      const unsubscribe =
        request.onProgress === undefined
          ? undefined
          : options.messaging.onBroadcast(STREAM_PROGRESS_BROADCAST, (payload) => {
              if (isProgress(payload) && payload.manifestUrl === request.manifestUrl) {
                request.onProgress?.({
                  segmentsDone: payload.segmentsDone,
                  segmentsTotal: payload.segmentsTotal,
                  bytesReceived: payload.bytesReceived,
                });
              }
            });

      // A caller-side abort has to reach the host: the fetches are happening there.
      const onAbort = (): void => {
        void options.messaging
          .send(
            'stream/abort',
            { manifestUrl: request.manifestUrl },
            { timeoutMs: RELEASE_TIMEOUT_MS },
          )
          .catch(() => undefined);
      };
      request.signal?.addEventListener('abort', onAbort, { once: true });

      const ceiling = request.maxTotalBytes ?? options.maxTotalBytes;
      try {
        const result = await options.messaging.send(
          'stream/assemble',
          {
            manifestUrl: request.manifestUrl,
            ...(ceiling !== undefined && { maxTotalBytes: ceiling }),
          },
          { timeoutMs: ASSEMBLE_TIMEOUT_MS },
        );
        live.add(result.url);
        let released = false;
        return {
          url: result.url,
          byteLength: result.byteLength,
          extension: result.extension,
          mimeType: result.mimeType,
          segmentCount: result.segmentCount,
          origins: result.origins,
          async release(): Promise<void> {
            if (released) {
              return;
            }
            released = true;
            live.delete(result.url);
            try {
              await options.messaging.send(
                'stream/release',
                { url: result.url },
                { timeoutMs: RELEASE_TIMEOUT_MS },
              );
            } catch {
              // The document may already be gone, which releases the bytes anyway.
            }
            await closeIfIdle();
          },
        };
      } finally {
        request.signal?.removeEventListener('abort', onAbort);
        unsubscribe?.();
        // Nothing to hold open if this attempt produced no delivery.
        await closeIfIdle();
      }
    },
  };
}
