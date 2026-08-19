/**
 * Test fixtures for the storage repositories: an in-memory {@link ObjectStore} with
 * injectable failures, and a DownloadTask builder. Not a test file.
 */
import type { ObjectStore } from '@platform/storage';
import type { DownloadTask, MediaItem } from '@shared/types';

export interface MemoryObjectStore extends ObjectStore<unknown> {
  /** Raw contents, for assertions. */
  readonly records: Map<string, unknown>;
  /** Operations that must reject until cleared (`getAll` / `put` / `delete`). */
  readonly failing: Set<string>;
  /** Recorded operations, in order, as `"<op>:<id>"`. */
  readonly calls: string[];
}

export function createMemoryObjectStore(): MemoryObjectStore {
  const records = new Map<string, unknown>();
  const failing = new Set<string>();
  const calls: string[] = [];

  const guard = (operation: string, id: string): Promise<never> | undefined => {
    calls.push(`${operation}:${id}`);
    return failing.has(operation) ? Promise.reject(new Error(`${operation} failed`)) : undefined;
  };

  return {
    records,
    failing,
    calls,
    put(id: string, value: unknown): Promise<void> {
      return (
        guard('put', id) ??
        Promise.resolve().then(() => {
          records.set(id, value);
        })
      );
    },
    get(id: string): Promise<unknown> {
      return guard('get', id) ?? Promise.resolve(records.get(id));
    },
    getAll(): Promise<readonly unknown[]> {
      return guard('getAll', '*') ?? Promise.resolve([...records.values()]);
    },
    delete(id: string): Promise<void> {
      return (
        guard('delete', id) ??
        Promise.resolve().then(() => {
          records.delete(id);
        })
      );
    },
    clear(): Promise<void> {
      return (
        guard('clear', '*') ??
        Promise.resolve().then(() => {
          records.clear();
        })
      );
    },
  };
}

export function mediaItem(props: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'https://example.com/v.mp4',
    kind: 'video',
    status: 'supported',
    title: 'Sample',
    url: 'https://example.com/v.mp4',
    originHost: 'example.com',
    detectedBy: 'html5-video',
    score: 1,
    discoveredAt: 0,
    ...props,
  };
}

export function downloadTask(props: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id: 't1',
    item: mediaItem(),
    state: 'queued',
    filename: 'Sample.mp4',
    attempt: 0,
    createdAt: 10,
    updatedAt: 20,
    ...props,
  };
}
