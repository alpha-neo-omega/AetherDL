/**
 * Module: core/detection/manager
 * Purpose: DetectorManager contract — orchestrates detection for a tab (PROJECT_BIBLE.md
 *          §9.1): registration, discovery, lifecycle, execution, priority ordering,
 *          aggregation via the pipeline, cache coordination, and events.
 *          Implementation in ./manager; composition in ../factory.
 * Restrictions: Domain layer — no browser globals, no UI, no download logic (§9.1).
 * Dependencies: shared/types, shared/result, shared/utils, core/detection/detectors,
 *          core/detection/pipeline.
 * Public API: DetectionEventMap, DetectorManager.
 */
import type { AppError } from '@shared/result';
import type { MediaItem } from '@shared/types';
import type { Unsubscribe } from '@shared/utils';
import type { Detector } from '@core/detection/detectors';
import type { DetectionContext } from '@core/detection/pipeline';

/** Payload of the `detection:finished` event. */
export interface DetectionFinished {
  readonly context: DetectionContext;
  readonly items: readonly MediaItem[];
  readonly fromCache: boolean;
}

/**
 * Strongly-typed detection lifecycle events (§ Phase 3 events). Declared as a type
 * alias (not an interface) so it satisfies the emitter's `Record<string, …>`
 * constraint via an implicit index signature.
 */
export type DetectionEventMap = {
  readonly 'detection:started': [DetectionContext];
  readonly 'detection:finished': [DetectionFinished];
  readonly 'detector:started': [{ readonly detectorId: string }];
  readonly 'detector:finished': [{ readonly detectorId: string; readonly candidateCount: number }];
  readonly 'media:detected': [MediaItem];
  readonly 'cache:hit': [{ readonly tabId: number }];
  readonly 'cache:miss': [{ readonly tabId: number }];
  readonly error: [AppError];
  // --- Phase 4 (advanced detection) ---
  readonly 'manifest:detected': [MediaItem];
  readonly 'network:media-detected': [MediaItem];
  readonly 'mediasource:detected': [MediaItem];
  readonly 'metadata:enriched': [{ readonly itemCount: number }];
  readonly 'correlation:complete': [
    { readonly itemCount: number; readonly corroboratedCount: number },
  ];
};

export interface DetectorManager {
  registerDetector(detector: Detector): void;
  unregisterDetector(id: string): void;
  getDetectors(): readonly Detector[];
  detect(context: DetectionContext): Promise<readonly MediaItem[]>;
  invalidate(tabId: number): void;
  on<K extends keyof DetectionEventMap>(
    event: K,
    listener: (...args: DetectionEventMap[K]) => void,
  ): Unsubscribe;
  /** Run cleanup() on all detectors and release resources. */
  dispose(): Promise<void>;
}
