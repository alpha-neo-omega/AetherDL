/**
 * Module: core/download/stream (delivery)
 * Purpose: Compose assembly (this layer) with the object-URL adapter (platform) into
 *          the {@link StreamDeliveryAdapter} the download manager consumes
 *          (PROJECT_BIBLE.md §10.6, §10.8). Runs wherever object URLs exist: a
 *          Firefox event page, or the Chromium offscreen document.
 * Restrictions: Domain layer — all I/O through the injected HttpClient and
 *          ObjectUrlAdapter ports (§8.4). Assembly refusals (encryption above all)
 *          propagate untouched (§6, ADR-005).
 * Dependencies: platform/http, platform/objecturl, platform/stream (types),
 *          core/download/stream (assemble).
 * Public API: LocalStreamDeliveryOptions, createLocalStreamDelivery.
 */
import type { HttpClient } from '@platform/http';
import type { ObjectUrlAdapter } from '@platform/objecturl';
import type {
  StreamDelivery,
  StreamDeliveryAdapter,
  StreamDeliveryRequest,
} from '@platform/stream';
import { assembleStream, detectStreamKind } from '@core/download/stream/assemble';

export interface LocalStreamDeliveryOptions {
  readonly http: HttpClient;
  readonly objectUrl: ObjectUrlAdapter;
  /** Overrides the assembly ceiling; the assembler's default applies otherwise. */
  readonly maxTotalBytes?: number;
}

export function createLocalStreamDelivery(
  options: LocalStreamDeliveryOptions,
): StreamDeliveryAdapter {
  return {
    supported: options.objectUrl.supported,
    handles(url: string): boolean {
      return detectStreamKind(url) !== undefined;
    },
    async assemble(request: StreamDeliveryRequest): Promise<StreamDelivery> {
      const ceiling = request.maxTotalBytes ?? options.maxTotalBytes;
      // The user's pinned rendition wins over the standing preference; the selection
      // object is omitted entirely when neither is set, so the assembler keeps its
      // own default rather than being handed an empty intent (§10.6).
      const selection = {
        ...(request.renditionId !== undefined && { renditionId: request.renditionId }),
        ...(request.preference !== undefined && { preference: request.preference }),
      };
      const assembled = await assembleStream({
        manifestUrl: request.manifestUrl,
        http: options.http,
        ...(Object.keys(selection).length > 0 && { selection }),
        ...(request.signal !== undefined && { signal: request.signal }),
        ...(request.onProgress !== undefined && { onProgress: request.onProgress }),
        ...(ceiling !== undefined && { maxTotalBytes: ceiling }),
      });
      if (!assembled.ok) {
        // The assembler's error already carries the code, the retryable flag and a
        // message safe to show; rethrowing it keeps one story for the whole path.
        throw assembled.error;
      }
      const handle = options.objectUrl.create(assembled.value.parts, assembled.value.mimeType);
      return {
        url: handle.url,
        byteLength: handle.byteLength,
        extension: assembled.value.extension,
        mimeType: assembled.value.mimeType,
        segmentCount: assembled.value.segmentCount,
        origins: assembled.value.origins,
        release(): Promise<void> {
          handle.release();
          return Promise.resolve();
        },
      };
    },
  };
}
