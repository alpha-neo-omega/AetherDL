/**
 * Module: core/detection (engine composition)
 * Purpose: Compose the detection subsystem into a ready DetectorManager
 *          (PROJECT_BIBLE.md §9). This is the detection composition root the
 *          background surface will use (dependency inversion, §8.4 rule 3).
 * Restrictions: Domain layer — wires pure components; clock injected for
 *          determinism (default uses the system clock).
 * Public API: DetectionEngineOptions, createDetectionEngine.
 */
import { TypedEventEmitter } from '@shared/utils';
import { createDetectionCache } from '@core/detection/cache/cache';
import { createCorrelator } from '@core/detection/dedupe/correlate';
import { createBlobMediaDetector } from '@core/detection/detectors/blob-media';
import { createDirectUrlDetector } from '@core/detection/detectors/direct-url';
import {
  createDashManifestDetector,
  createHlsManifestDetector,
} from '@core/detection/detectors/manifest';
import { createHtml5AudioDetector } from '@core/detection/detectors/html5-audio';
import { createHtml5VideoDetector } from '@core/detection/detectors/html5-video';
import { createMediaSourceDetector } from '@core/detection/detectors/media-source';
import { createNetworkMediaDetector } from '@core/detection/detectors/network-media';
import type { DetectionEventMap, DetectorManager } from '@core/detection/manager';
import { createDetectorManager } from '@core/detection/manager/manager';
import { createMetadataExtractor } from '@core/detection/metadata/metadata';
import { createDetectionPipeline } from '@core/detection/pipeline/pipeline';
import { createScorer } from '@core/detection/scoring/scoring';

export interface DetectionEngineOptions {
  /** Injectable clock for deterministic timestamps (default: system clock). */
  readonly clock?: () => number;
  /** Max tabs cached before LRU eviction (§9.9). */
  readonly maxTabs?: number;
  /** Max cache entry age in ms (§12.5). */
  readonly maxAgeMs?: number;
  /** Per-detector execution budget in ms (§9.10). */
  readonly perDetectorTimeoutMs?: number;
  /** Cap on candidates accepted from a single detector (§9.10). */
  readonly maxCandidatesPerDetector?: number;
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;

/**
 * Build a fully-wired {@link DetectorManager} with the Phase 3 built-in detectors
 * (html5-video, html5-audio, direct-url, blob-media) registered.
 */
export function createDetectionEngine(options: DetectionEngineOptions = {}): DetectorManager {
  const clock = options.clock ?? ((): number => Date.now());
  const maxTabs = options.maxTabs ?? 50;
  const maxAgeMs = options.maxAgeMs ?? FIVE_MINUTES_MS;
  const perDetectorTimeoutMs = options.perDetectorTimeoutMs ?? 250;
  const maxCandidatesPerDetector = options.maxCandidatesPerDetector ?? 200;

  const emitter = new TypedEventEmitter<DetectionEventMap>();
  const scorer = createScorer();
  const metadataExtractor = createMetadataExtractor();

  // Built-in detectors (Phase 3 + Phase 4). The correlation engine uses a priority
  // resolver so the merge base is the higher-priority detector (§9.4/§9.5).
  const detectors = [
    createHtml5VideoDetector(),
    createHtml5AudioDetector(),
    createDirectUrlDetector(),
    createNetworkMediaDetector(),
    createHlsManifestDetector(),
    createDashManifestDetector(),
    createBlobMediaDetector(),
    createMediaSourceDetector(),
  ];
  const priorityByDetector = new Map(detectors.map((detector) => [detector.id, detector.priority]));
  const deduplicator = createCorrelator({
    priorityOf: (detectedBy) => priorityByDetector.get(detectedBy) ?? 0,
  });
  const pipeline = createDetectionPipeline({
    scorer,
    deduplicator,
    metadataExtractor,
    clock,
    onReject: (_candidate, error) => {
      emitter.emit('error', error.toAppError());
    },
  });
  const cache = createDetectionCache({ clock, maxTabs, maxAgeMs });

  const manager = createDetectorManager({
    emitter,
    pipeline,
    cache,
    perDetectorTimeoutMs,
    maxCandidatesPerDetector,
  });

  for (const detector of detectors) {
    manager.registerDetector(detector);
  }

  return manager;
}
