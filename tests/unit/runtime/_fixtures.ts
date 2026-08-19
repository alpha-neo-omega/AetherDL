/**
 * Test fixtures for the runtime layer: builders for MediaItem + DetectionReport and
 * a controllable fake DetectorManager (so runtime orchestration is tested without
 * re-running real detectors). Not a test file.
 */
import type { DetectionEventMap, DetectorManager } from '@core/detection/manager';
import type { DetectionContext } from '@core/detection/pipeline';
import type { DetectionReport, MediaItem } from '@shared/types';
import { TypedEventEmitter } from '@shared/utils';

export function mediaItem(props: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'm1',
    kind: 'video',
    status: 'supported',
    title: 'Video',
    url: 'https://example.com/v.mp4',
    originHost: 'example.com',
    detectedBy: 'html5-video',
    score: 1,
    discoveredAt: 0,
    ...props,
  };
}

export function report(props: Partial<DetectionReport> = {}): DetectionReport {
  return {
    pageUrl: 'https://example.com/watch',
    domSignals: [],
    observedUrls: [],
    ...props,
  };
}

export interface FakeEngine {
  readonly manager: DetectorManager;
  readonly emitter: TypedEventEmitter<DetectionEventMap>;
  readonly invalidated: number[];
  readonly contexts: DetectionContext[];
  setItems(items: readonly MediaItem[]): void;
  failNext(): void;
  /** Suspend the next detect() until release() (to test in-flight races). */
  hold(): void;
  release(): void;
  disposed(): boolean;
}

export function createFakeEngine(): FakeEngine {
  const emitter = new TypedEventEmitter<DetectionEventMap>();
  const invalidated: number[] = [];
  const contexts: DetectionContext[] = [];
  let nextItems: readonly MediaItem[] = [];
  let throwNext = false;
  let isDisposed = false;
  let gate: { readonly promise: Promise<void>; readonly resolve: () => void } | undefined;

  const manager: DetectorManager = {
    registerDetector: () => undefined,
    unregisterDetector: () => undefined,
    getDetectors: () => [],
    async detect(context: DetectionContext): Promise<readonly MediaItem[]> {
      contexts.push(context);
      if (gate !== undefined) {
        await gate.promise;
      }
      if (throwNext) {
        throwNext = false;
        throw new Error('detect failed');
      }
      emitter.emit('detection:started', context);
      const items = nextItems;
      emitter.emit('detection:finished', { context, items, fromCache: false });
      return items;
    },
    invalidate(tabId: number): void {
      invalidated.push(tabId);
    },
    on(event, listener) {
      return emitter.on(event, listener);
    },
    async dispose(): Promise<void> {
      isDisposed = true;
    },
  };

  return {
    manager,
    emitter,
    invalidated,
    contexts,
    setItems: (items) => {
      nextItems = items;
    },
    failNext: () => {
      throwNext = true;
    },
    hold: () => {
      let resolve!: () => void;
      const promise = new Promise<void>((res) => {
        resolve = res;
      });
      gate = { promise, resolve };
    },
    release: () => {
      gate?.resolve();
      gate = undefined;
    },
    disposed: () => isDisposed,
  };
}
