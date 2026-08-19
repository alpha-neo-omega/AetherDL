/**
 * Module: core/detection/manager (implementation)
 * Purpose: DetectorManager implementation (PROJECT_BIBLE.md §9.1): registry,
 *          discovery, lifecycle, priority-ordered bounded execution, aggregation via
 *          the pipeline, cache coordination, and events.
 * Restrictions: Domain layer — no browser globals, no UI, no download logic. Slow or
 *          throwing detectors are isolated (per-detector timeout, §9.10) and never
 *          fail the whole pass.
 * Public API: DetectorManagerOptions, createDetectorManager.
 */
import { PlatformError } from '@shared/result/errors';
import type { MediaItem } from '@shared/types';
import type { TypedEventEmitter, Unsubscribe } from '@shared/utils';
import type { DetectionCache } from '@core/detection/cache';
import type { Detector } from '@core/detection/detectors';
import { DetectorFailure } from '@core/detection/errors';
import type { DetectionEventMap, DetectorManager } from '@core/detection/manager';
import type { DetectionContext, DetectionPipeline, RawCandidate } from '@core/detection/pipeline';

export interface DetectorManagerOptions {
  readonly emitter: TypedEventEmitter<DetectionEventMap>;
  readonly pipeline: DetectionPipeline;
  readonly cache: DetectionCache;
  readonly perDetectorTimeoutMs: number;
  readonly maxCandidatesPerDetector: number;
}

function runWithTimeout(
  work: Promise<readonly RawCandidate[]>,
  timeoutMs: number,
  detectorId: string,
): Promise<readonly RawCandidate[]> {
  return new Promise<readonly RawCandidate[]>((resolve, reject) => {
    const handle = setTimeout(() => {
      reject(
        new DetectorFailure(`Detector "${detectorId}" exceeded ${timeoutMs}ms`, {
          code: 'detector-timeout',
          messageKey: 'error.detection.timeout',
          context: { detectorId },
        }),
      );
    }, timeoutMs);
    work.then(
      (value) => {
        clearTimeout(handle);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(handle);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function createDetectorManager(options: DetectorManagerOptions): DetectorManager {
  const { emitter, pipeline, cache, perDetectorTimeoutMs, maxCandidatesPerDetector } = options;
  const registry = new Map<string, Detector>();

  const emitError = (fallback: string, code: string, cause: unknown, detectorId?: string): void => {
    const error =
      cause instanceof PlatformError
        ? cause
        : new DetectorFailure(fallback, {
            code,
            messageKey: 'error.detection.detector',
            cause,
            ...(detectorId !== undefined && { context: { detectorId } }),
          });
    emitter.emit('error', error.toAppError());
  };

  const safeCanDetect = (detector: Detector, context: DetectionContext): boolean => {
    try {
      return detector.canDetect(context);
    } catch (cause) {
      emitError(
        `Detector "${detector.id}" canDetect failed`,
        'detector-can-detect-failed',
        cause,
        detector.id,
      );
      return false;
    }
  };

  const runDetector = async (
    detector: Detector,
    context: DetectionContext,
  ): Promise<readonly RawCandidate[]> => {
    emitter.emit('detector:started', { detectorId: detector.id });
    try {
      const produced = await runWithTimeout(
        Promise.resolve(detector.detect(context)),
        perDetectorTimeoutMs,
        detector.id,
      );
      const capped =
        produced.length > maxCandidatesPerDetector
          ? produced.slice(0, maxCandidatesPerDetector)
          : produced;
      emitter.emit('detector:finished', { detectorId: detector.id, candidateCount: capped.length });
      return capped;
    } catch (cause) {
      emitError(`Detector "${detector.id}" failed`, 'detector-failed', cause, detector.id);
      return [];
    }
  };

  return {
    registerDetector(detector: Detector): void {
      registry.set(detector.id, detector);
      const started = detector.initialize?.();
      if (started instanceof Promise) {
        started.catch((cause: unknown) => {
          emitError(
            `Detector "${detector.id}" initialize failed`,
            'detector-init-failed',
            cause,
            detector.id,
          );
        });
      }
    },

    unregisterDetector(id: string): void {
      const detector = registry.get(id);
      if (detector === undefined) {
        return;
      }
      registry.delete(id);
      const stopped = detector.cleanup?.();
      if (stopped instanceof Promise) {
        stopped.catch((cause: unknown) => {
          emitError(`Detector "${id}" cleanup failed`, 'detector-cleanup-failed', cause, id);
        });
      }
    },

    getDetectors(): readonly Detector[] {
      return [...registry.values()];
    },

    async detect(context: DetectionContext): Promise<readonly MediaItem[]> {
      const cached = cache.get(context.tabId, context.pageUrl);
      if (cached !== undefined) {
        emitter.emit('cache:hit', { tabId: context.tabId });
        emitter.emit('detection:finished', { context, items: cached, fromCache: true });
        return cached;
      }
      emitter.emit('cache:miss', { tabId: context.tabId });
      emitter.emit('detection:started', context);

      const active = [...registry.values()]
        .filter((detector) => detector.enabled !== false && safeCanDetect(detector, context))
        .sort((a, b) => b.priority - a.priority);

      const produced = await Promise.all(active.map((detector) => runDetector(detector, context)));
      const candidates = produced.flat();

      const items = await pipeline.run(context, candidates);
      let corroboratedCount = 0;
      for (const item of items) {
        emitter.emit('media:detected', item);
        if (item.delivery === 'hls' || item.delivery === 'dash') {
          emitter.emit('manifest:detected', item);
        }
        if (item.detectedBy === 'network-media') {
          emitter.emit('network:media-detected', item);
        }
        if (item.detectedBy === 'media-source') {
          emitter.emit('mediasource:detected', item);
        }
        if (item.metadata?.['corroboratedBy'] !== undefined) {
          corroboratedCount += 1;
        }
      }
      emitter.emit('metadata:enriched', { itemCount: items.length });
      emitter.emit('correlation:complete', { itemCount: items.length, corroboratedCount });
      cache.set(context.tabId, items, context.pageUrl);
      emitter.emit('detection:finished', { context, items, fromCache: false });
      return items;
    },

    invalidate(tabId: number): void {
      cache.invalidate(tabId);
    },

    on<K extends keyof DetectionEventMap>(
      event: K,
      listener: (...args: DetectionEventMap[K]) => void,
    ): Unsubscribe {
      return emitter.on(event, listener);
    },

    async dispose(): Promise<void> {
      const detectors = [...registry.values()];
      registry.clear();
      await Promise.all(
        detectors.map(async (detector) => {
          try {
            await detector.cleanup?.();
          } catch (cause) {
            emitError(
              `Detector "${detector.id}" cleanup failed`,
              'detector-cleanup-failed',
              cause,
              detector.id,
            );
          }
        }),
      );
      cache.invalidateAll();
      emitter.clear();
    },
  };
}
