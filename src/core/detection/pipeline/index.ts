/**
 * Module: core/detection/pipeline
 * Purpose: Detection pipeline contract and its strongly-typed inputs
 *          (PROJECT_BIBLE.md §9.3). Implementation in ./pipeline; validation in
 *          ./validate.
 * Restrictions: Domain layer — pure; platform via interfaces; no UI/runtime (§8.4).
 * Dependencies: shared/types.
 * Public API: DomSignalRole, DomSignal, DetectionSource, DetectionContext,
 *          RawCandidate, DetectionPipeline.
 *
 * Note: the DomSignal / DetectionContext / RawCandidate shapes were elaborated in
 * Phase 3 (additive to the Phase 1 skeletons); pending ADR-007 ratification.
 */
import type { DeliveryType, MediaItem, MediaKind } from '@shared/types';

/** The DOM element role a signal was extracted from (by the content script). */
export type DomSignalRole = 'video' | 'audio' | 'source' | 'link';

/**
 * A plain-data snapshot of a media-relevant DOM node, produced by the content
 * script (isolated world, §8.10) and consumed by detectors. Detectors never touch
 * the live DOM; they read these signals.
 */
export interface DomSignal {
  readonly role: DomSignalRole;
  readonly tagName: string;
  readonly src?: string;
  readonly currentSrc?: string;
  readonly href?: string;
  readonly type?: string;
  readonly width?: number;
  readonly height?: number;
  readonly durationSec?: number;
  /** Role of the containing media element for `<source>` signals. */
  readonly parentRole?: DomSignalRole;
  readonly title?: string;
  // --- Phase 4 (additive) ---
  /** Codec string reported by the element/source, when known (§9.8). */
  readonly codecs?: string;
  /** The element is backed by the MediaSource API (MSE) (§5.4 blob family). */
  readonly mediaSource?: boolean;
  /** The element has Encrypted Media Extensions attached (EME/DRM, §6). */
  readonly encrypted?: boolean;
}

/**
 * A media resource observed via the browser's networking, produced by the platform
 * network observer (§12.6). Observation only — never intercepts encrypted traffic
 * or bypasses browser security.
 */
export interface NetworkResource {
  readonly url: string;
  readonly mimeType?: string;
  readonly sizeBytes?: number;
  readonly statusCode?: number;
  readonly fromCache?: boolean;
}

/** Where a detection context originated. */
export type DetectionSource = 'dom' | 'network' | 'manual';

/** Strongly-typed, immutable context for one detection pass (§9.3). */
export interface DetectionContext {
  readonly tabId: number;
  readonly frameId?: number;
  readonly pageUrl: string;
  readonly documentTitle?: string;
  readonly domSignals: readonly DomSignal[];
  readonly observedUrls: readonly string[];
  /** Structured media resources observed over the network (Phase 4, additive). */
  readonly networkResources?: readonly NetworkResource[];
  /** Browser capability flags relevant to detection (§7.2), best-effort. */
  readonly capabilities?: Readonly<Record<string, boolean>>;
  readonly source: DetectionSource;
  /** Context creation time, epoch ms (injected clock). */
  readonly timestamp: number;
}

/** A raw, pre-validation candidate emitted by a detector (§9.3). */
export interface RawCandidate {
  readonly url: string;
  readonly originalUrl?: string;
  readonly kind: MediaKind;
  readonly container?: string;
  readonly mimeType?: string;
  readonly title?: string;
  readonly filename?: string;
  readonly width?: number;
  readonly height?: number;
  readonly durationSec?: number;
  readonly detectedBy: string;
  /** Detector self-confidence hint in [0,1]; the scorer may refine it (§9.7). */
  readonly confidence?: number;
  /** Opaque per-source identity (element/blob) to aid dedupe (§9.5). */
  readonly sourceKey?: string;
  readonly isBlob?: boolean;
  // --- Phase 4 (additive) ---
  readonly sizeBytes?: number;
  readonly bitrateKbps?: number;
  readonly codec?: string;
  /** Delivery hint from the detector; the pipeline classifies if absent (§5.5). */
  readonly delivery?: DeliveryType;
  /** Encrypted-media (EME/DRM) indicator — classified unsupported (§6). */
  readonly encrypted?: boolean;
}

export interface DetectionPipeline {
  run(
    context: DetectionContext,
    candidates: readonly RawCandidate[],
  ): Promise<readonly MediaItem[]>;
}
