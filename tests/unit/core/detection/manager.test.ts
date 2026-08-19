import { describe, expect, it, vi } from 'vitest';
import { createDetectionCache } from '@core/detection/cache/cache';
import type { Detector } from '@core/detection/detectors';
import type { DetectionEventMap, DetectorManager } from '@core/detection/manager';
import { createDetectorManager } from '@core/detection/manager/manager';
import type { DetectionPipeline, RawCandidate } from '@core/detection/pipeline';
import type { MediaItem } from '@shared/types';
import { TypedEventEmitter } from '@shared/utils';
import { context } from './_fixtures';

const stubPipeline: DetectionPipeline = {
  run: (_context, candidates) =>
    Promise.resolve(
      candidates.map(
        (candidate) =>
          ({
            id: candidate.url,
            kind: candidate.kind,
            status: 'supported',
            title: 't',
            url: candidate.url,
            originHost: 'x.com',
            detectedBy: candidate.detectedBy,
            score: 1,
            discoveredAt: 0,
          }) satisfies MediaItem,
      ),
    ),
};

function makeManager(perDetectorTimeoutMs = 250, maxCandidatesPerDetector = 200): DetectorManager {
  return createDetectorManager({
    emitter: new TypedEventEmitter<DetectionEventMap>(),
    pipeline: stubPipeline,
    cache: createDetectionCache({ clock: () => 0, maxTabs: 10, maxAgeMs: 100_000 }),
    perDetectorTimeoutMs,
    maxCandidatesPerDetector,
  });
}

interface RecorderOptions {
  readonly enabled?: boolean;
  readonly canDetect?: boolean;
  readonly initialize?: () => void;
  readonly cleanup?: () => void;
}

function recorder(
  id: string,
  priority: number,
  calls: string[],
  options: RecorderOptions = {},
): Detector {
  return {
    id,
    name: id,
    priority,
    enabled: options.enabled ?? true,
    ...(options.initialize !== undefined && { initialize: options.initialize }),
    ...(options.cleanup !== undefined && { cleanup: options.cleanup }),
    canDetect: () => options.canDetect ?? true,
    detect: (): Promise<readonly RawCandidate[]> => {
      calls.push(id);
      return Promise.resolve([{ url: `https://x.com/${id}.mp4`, kind: 'video', detectedBy: id }]);
    },
  };
}

describe('detector manager', () => {
  it('runs enabled, applicable detectors in priority order', async () => {
    const manager = makeManager();
    const calls: string[] = [];
    manager.registerDetector(recorder('low', 10, calls));
    manager.registerDetector(recorder('high', 90, calls));
    manager.registerDetector(recorder('disabled', 99, calls, { enabled: false }));
    manager.registerDetector(recorder('inapplicable', 95, calls, { canDetect: false }));

    const items = await manager.detect(context());
    expect(calls).toEqual(['high', 'low']);
    expect(items.map((item) => item.detectedBy).sort()).toEqual(['high', 'low']);
  });

  it('emits the lifecycle event sequence', async () => {
    const manager = makeManager();
    const calls: string[] = [];
    manager.registerDetector(recorder('a', 10, calls));

    const events: string[] = [];
    for (const name of [
      'detection:started',
      'detector:started',
      'detector:finished',
      'media:detected',
      'detection:finished',
      'cache:miss',
    ] as const) {
      manager.on(name, () => events.push(name));
    }
    await manager.detect(context());
    // Assert the actual firing ORDER, not mere presence.
    expect(events.indexOf('cache:miss')).toBeLessThan(events.indexOf('detection:started'));
    expect(events.indexOf('detection:started')).toBeLessThan(events.indexOf('detector:started'));
    expect(events.indexOf('detector:started')).toBeLessThan(events.indexOf('detector:finished'));
    expect(events.indexOf('detector:finished')).toBeLessThan(events.indexOf('media:detected'));
    expect(events.indexOf('media:detected')).toBeLessThan(events.indexOf('detection:finished'));
  });

  it('serves cached results without re-running detectors, then re-runs after invalidate', async () => {
    const manager = makeManager();
    const calls: string[] = [];
    manager.registerDetector(recorder('a', 10, calls));
    const ctx = context({ tabId: 7, pageUrl: 'https://x.com/watch' });

    await manager.detect(ctx);
    const afterFirst = calls.length;

    const hit = vi.fn();
    manager.on('cache:hit', hit);
    await manager.detect(ctx);
    expect(calls.length).toBe(afterFirst);
    expect(hit).toHaveBeenCalledWith({ tabId: 7 });

    manager.invalidate(7);
    await manager.detect(ctx);
    expect(calls.length).toBeGreaterThan(afterFirst);
  });

  it('isolates a detector whose canDetect throws and ignores unknown unregister', async () => {
    const manager = makeManager();
    const calls: string[] = [];
    const errors = vi.fn();
    manager.on('error', errors);
    manager.registerDetector({
      id: 'bad-can',
      name: 'bad-can',
      priority: 50,
      canDetect: () => {
        throw new Error('canDetect boom');
      },
      detect: () => Promise.resolve([]),
    });
    manager.registerDetector(recorder('ok', 10, calls));

    manager.unregisterDetector('does-not-exist'); // no-op, must not throw
    const items = await manager.detect(context());
    expect(errors).toHaveBeenCalled();
    expect(calls).toEqual(['ok']);
    expect(items.map((item) => item.detectedBy)).toEqual(['ok']);
  });

  it('isolates a throwing detector and still completes', async () => {
    const manager = makeManager();
    const calls: string[] = [];
    const errors = vi.fn();
    manager.on('error', errors);
    manager.registerDetector({
      id: 'boom',
      name: 'boom',
      priority: 100,
      canDetect: () => true,
      detect: () => Promise.reject(new Error('boom')),
    });
    manager.registerDetector(recorder('ok', 10, calls));

    const items = await manager.detect(context());
    expect(errors).toHaveBeenCalled();
    expect(calls).toContain('ok');
    expect(items.map((item) => item.detectedBy)).toEqual(['ok']);
  });

  it('times out a slow detector without failing the pass', async () => {
    const manager = makeManager(10);
    const errors = vi.fn();
    manager.on('error', errors);
    manager.registerDetector({
      id: 'slow',
      name: 'slow',
      priority: 50,
      canDetect: () => true,
      detect: () => new Promise<readonly RawCandidate[]>(() => undefined),
    });
    const items = await manager.detect(context());
    expect(errors).toHaveBeenCalled();
    expect(items).toHaveLength(0);
  });

  it('caps candidates per detector', async () => {
    const manager = makeManager(250, 1);
    const finished = vi.fn();
    manager.on('detector:finished', finished);
    manager.registerDetector({
      id: 'many',
      name: 'many',
      priority: 1,
      canDetect: () => true,
      detect: () =>
        Promise.resolve<readonly RawCandidate[]>([
          { url: 'https://x.com/1.mp4', kind: 'video', detectedBy: 'many' },
          { url: 'https://x.com/2.mp4', kind: 'video', detectedBy: 'many' },
          { url: 'https://x.com/3.mp4', kind: 'video', detectedBy: 'many' },
        ]),
    });
    await manager.detect(context());
    expect(finished).toHaveBeenCalledWith({ detectorId: 'many', candidateCount: 1 });
  });

  it('runs detector lifecycle: initialize on register, cleanup on unregister/dispose', async () => {
    const manager = makeManager();
    const initialize = vi.fn();
    const cleanup = vi.fn();
    manager.registerDetector(recorder('lc', 10, [], { initialize, cleanup }));
    expect(initialize).toHaveBeenCalledOnce();
    expect(manager.getDetectors()).toHaveLength(1);

    manager.unregisterDetector('lc');
    expect(cleanup).toHaveBeenCalledOnce();
    expect(manager.getDetectors()).toHaveLength(0);

    const disposeCleanup = vi.fn();
    manager.registerDetector(recorder('d', 5, [], { cleanup: disposeCleanup }));
    await manager.dispose();
    expect(disposeCleanup).toHaveBeenCalledOnce();
    expect(manager.getDetectors()).toHaveLength(0);
  });

  it('surfaces async lifecycle failures as error events', async () => {
    const manager = makeManager();
    const errors = vi.fn();
    manager.on('error', errors);

    manager.registerDetector({
      id: 'init-fail',
      name: 'init-fail',
      priority: 1,
      initialize: () => Promise.reject(new Error('init boom')),
      canDetect: () => false,
      detect: () => Promise.resolve([]),
    });
    manager.registerDetector({
      id: 'cleanup-fail',
      name: 'cleanup-fail',
      priority: 1,
      cleanup: () => Promise.reject(new Error('cleanup boom')),
      canDetect: () => false,
      detect: () => Promise.resolve([]),
    });
    manager.unregisterDetector('cleanup-fail');

    // Let the rejected lifecycle promises settle.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(errors).toHaveBeenCalledTimes(2);
  });

  it('isolates a cleanup that throws during dispose', async () => {
    const manager = makeManager();
    const errors = vi.fn();
    manager.on('error', errors);
    manager.registerDetector({
      id: 'throws-on-cleanup',
      name: 'throws-on-cleanup',
      priority: 1,
      cleanup: () => {
        throw new Error('sync cleanup boom');
      },
      canDetect: () => false,
      detect: () => Promise.resolve([]),
    });
    await manager.dispose();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(manager.getDetectors()).toHaveLength(0);
  });
});
