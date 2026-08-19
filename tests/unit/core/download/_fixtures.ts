/**
 * Test fixtures for the download manager: a MediaItem builder, an in-memory fake
 * DownloadsAdapter (drives start/cancel/getProgress/onChanged), and a manual timer
 * for deterministic retry scheduling. Not a test file.
 */
import type { MediaItem, TaskState } from '@shared/types';
import type {
  DownloadChange,
  DownloadProgress,
  DownloadsAdapter,
  NativeDownloadOptions,
} from '@platform/downloads';

/** Build a MediaItem. Overrides may pass `undefined` to clear an optional field. */
export function mediaItem(
  props: { readonly [K in keyof MediaItem]?: MediaItem[K] | undefined } = {},
): MediaItem {
  const url = props.url ?? 'https://example.com/video.mp4';
  const merged: Record<string, unknown> = {
    id: url,
    kind: 'video',
    status: 'supported',
    title: 'Sample Video',
    url,
    originHost: 'example.com',
    detectedBy: 'html5-video',
    delivery: 'html5',
    container: 'mp4',
    extension: 'mp4',
    score: 1,
    discoveredAt: 0,
    ...props,
  };
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(merged)) {
    if (merged[key] !== undefined) {
      result[key] = merged[key];
    }
  }
  return result as unknown as MediaItem;
}

interface FakeItem {
  state: TaskState;
  bytesReceived: number;
  bytesTotal: number | undefined;
}

export interface FakeDownloads {
  readonly adapter: DownloadsAdapter;
  /** Native download options passed to start(), in order. */
  readonly started: NativeDownloadOptions[];
  /** Native ids passed to cancel(), in order. */
  readonly canceled: number[];
  /** When true, the next start() rejects. */
  failNextStart: boolean;
  /** When true, getProgress() rejects. */
  failProgress: boolean;
  /** Suspend the next start() calls until releaseStart() (simulates a slow start). */
  holdStart(): void;
  /** Resolve all suspended start() calls, assigning native ids. */
  releaseStart(): void;
  /** Push a change event to all listeners. */
  emit(change: DownloadChange): void;
  /** Update the simulated native item. */
  setItem(id: number, patch: Partial<FakeItem>): void;
}

export function createFakeDownloads(): FakeDownloads {
  const started: NativeDownloadOptions[] = [];
  const canceled: number[] = [];
  const items = new Map<number, FakeItem>();
  const listeners = new Set<(change: DownloadChange) => void>();
  let nextId = 1;
  let holding = false;
  const startResolvers: Array<(id: number) => void> = [];

  const allocate = (): number => {
    const id = nextId;
    nextId += 1;
    items.set(id, { state: 'active', bytesReceived: 0, bytesTotal: 100 });
    return id;
  };

  const fake: FakeDownloads = {
    started,
    canceled,
    failNextStart: false,
    failProgress: false,
    adapter: {
      start(options: NativeDownloadOptions): Promise<number> {
        started.push(options);
        if (fake.failNextStart) {
          fake.failNextStart = false;
          return Promise.reject(new Error('native start failed'));
        }
        if (holding) {
          return new Promise<number>((resolve) => {
            startResolvers.push(resolve);
          });
        }
        return Promise.resolve(allocate());
      },
      cancel(id: number): Promise<void> {
        canceled.push(id);
        const item = items.get(id);
        if (item !== undefined) {
          item.state = 'canceled';
        }
        return Promise.resolve();
      },
      getProgress(id: number): Promise<DownloadProgress | undefined> {
        if (fake.failProgress) {
          return Promise.reject(new Error('progress query failed'));
        }
        const item = items.get(id);
        if (item === undefined) {
          return Promise.resolve(undefined);
        }
        return Promise.resolve({
          id,
          state: item.state,
          bytesReceived: item.bytesReceived,
          bytesTotal: item.bytesTotal,
        });
      },
      onChanged(listener: (change: DownloadChange) => void): () => void {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    holdStart(): void {
      holding = true;
    },
    releaseStart(): void {
      holding = false;
      for (const resolve of startResolvers.splice(0)) {
        resolve(allocate());
      }
    },
    emit(change: DownloadChange): void {
      for (const listener of [...listeners]) {
        listener(change);
      }
    },
    setItem(id: number, patch: Partial<FakeItem>): void {
      const item = items.get(id);
      items.set(id, {
        state: patch.state ?? item?.state ?? 'active',
        bytesReceived: patch.bytesReceived ?? item?.bytesReceived ?? 0,
        bytesTotal: patch.bytesTotal ?? item?.bytesTotal,
      });
    },
  };
  return fake;
}

export interface ManualTimer {
  readonly schedule: (delayMs: number, callback: () => void) => () => void;
  readonly pending: number;
  fireAll(): void;
}

export function createManualTimer(): ManualTimer {
  const callbacks: Array<{ cb: () => void; cancelled: boolean }> = [];
  return {
    schedule(_delayMs: number, cb: () => void): () => void {
      const entry = { cb, cancelled: false };
      callbacks.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    get pending(): number {
      return callbacks.filter((c) => !c.cancelled).length;
    },
    fireAll(): void {
      const snapshot = [...callbacks];
      callbacks.length = 0;
      for (const entry of snapshot) {
        if (!entry.cancelled) {
          entry.cb();
        }
      }
    },
  };
}

/** Flush pending microtasks + a macrotask so fire-and-forget async settles. */
export function tick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}
