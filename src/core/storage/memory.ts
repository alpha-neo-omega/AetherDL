/**
 * Module: core/storage (in-memory repositories)
 * Purpose: In-memory reference implementations of the storage repositories
 *          (PROJECT_BIBLE.md §8.14). The download manager persists/rehydrates the
 *          queue through the QueueRepository abstraction; a durable IndexedDB-backed
 *          repository is wired when the IndexedDB platform adapter exists. This
 *          in-memory impl is the default/test double (does not survive a restart).
 * Restrictions: Domain layer — local-only; no browser APIs (§14).
 * Public API: createInMemoryQueueRepository.
 */
import type { DownloadTask } from '@shared/types';
import type { QueueRepository } from '@core/storage';

export function createInMemoryQueueRepository(): QueueRepository {
  let tasks: readonly DownloadTask[] = [];
  return {
    load(): Promise<readonly DownloadTask[]> {
      return Promise.resolve(tasks);
    },
    save(next: readonly DownloadTask[]): Promise<void> {
      tasks = [...next];
      return Promise.resolve();
    },
  };
}
