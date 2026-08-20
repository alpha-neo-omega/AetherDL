/**
 * Module: platform/stream
 * Purpose: The contract by which the download manager obtains a locally saved-ready
 *          URL for an assembled HLS/DASH stream (PROJECT_BIBLE.md §10.6, §10.8).
 *          Whoever implements it does the assembling; the manager only ever sees a
 *          URL, so the actual write still belongs to the browser's download manager.
 * Restrictions: Platform layer — declares types only. An implementation MUST refuse
 *          encrypted/DRM streams; no key handling exists anywhere (§6, ADR-005).
 * Dependencies: shared/types (the quality preference vocabulary).
 * Public API: StreamAssemblyProgressReport, StreamDeliveryRequest, StreamDelivery,
 *          StreamDeliveryAdapter.
 */
import type { StreamQualityPreference } from '@shared/types';
export interface StreamAssemblyProgressReport {
  readonly segmentsDone: number;
  readonly segmentsTotal: number;
  readonly bytesReceived: number;
}

export interface StreamDeliveryRequest {
  readonly manifestUrl: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: StreamAssemblyProgressReport) => void;
  readonly maxTotalBytes?: number;
  /** The rendition the user pinned before queueing, if any (§10.6). */
  readonly renditionId?: string;
  /** The standing quality preference, applied when nothing is pinned (§10.6). */
  readonly preference?: StreamQualityPreference;
}

export interface StreamDelivery {
  /** A local, extension-origin URL the Downloads API can save. */
  readonly url: string;
  readonly byteLength: number;
  /** The container the assembled bytes actually are (`ts` or `mp4`). */
  readonly extension: string;
  readonly mimeType: string;
  readonly segmentCount: number;
  /** Origins the assembly read from — what a host-permission prompt should name. */
  readonly origins: readonly string[];
  /** Release the URL and its bytes. MUST be called once the save has settled. */
  release(): Promise<void>;
}

export interface StreamDeliveryAdapter {
  /** Whether this build/context can assemble at all (§7.2). */
  readonly supported: boolean;
  /** Whether the URL names a manifest this adapter would attempt. */
  handles(url: string): boolean;
  assemble(request: StreamDeliveryRequest): Promise<StreamDelivery>;
  /**
   * Discard anything an earlier session left behind — implemented where a
   * session CAN leave something behind. A Chromium offscreen document outlives the
   * service worker that opened it, so after a worker restart a document may still be
   * holding a stream-sized blob that nothing tracks any more; the composition root
   * calls this once at start-up to drop it (§8.9, §12.1).
   */
  reset?(): Promise<void>;
}
