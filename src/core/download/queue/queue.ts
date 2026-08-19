/**
 * Module: core/download/queue (implementation)
 * Purpose: The in-memory, ordered download-job store — the single source of truth
 *          for download state (PROJECT_BIBLE.md §10.2, §4.4). Persists through an
 *          injected QueueRepository (§8.14); rehydrates on startup (§8.9).
 * Restrictions: Domain layer — persistence via repository only; no browser APIs.
 * Public API: DownloadQueueOptions, createDownloadQueue.
 */
import type { DownloadTask, TaskState } from '@shared/types';
import type { QueueRepository } from '@core/storage';
import type { DownloadQueue, QueueStats } from '@core/download/queue';

export interface DownloadQueueOptions {
  /** Durable store for persistence; omitted → in-memory only. */
  readonly repository?: QueueRepository;
}

/** States that cannot be live after a fresh load and are requeued on hydrate. */
const INTERRUPTED_ON_LOAD: ReadonlySet<TaskState> = new Set<TaskState>([
  'preparing',
  'active',
  'retrying',
]);

export function createDownloadQueue(options: DownloadQueueOptions = {}): DownloadQueue {
  const { repository } = options;
  // Insertion order preserved for deterministic FIFO tiebreaks.
  const tasks = new Map<string, DownloadTask>();

  const persist = async (): Promise<void> => {
    if (repository !== undefined) {
      await repository.save([...tasks.values()]);
    }
  };

  return {
    async add(task: DownloadTask): Promise<void> {
      tasks.set(task.id, task);
      await persist();
    },

    async update(task: DownloadTask): Promise<void> {
      tasks.set(task.id, task);
      await persist();
    },

    async remove(taskId: string): Promise<void> {
      tasks.delete(taskId);
      await persist();
    },

    all(): Promise<readonly DownloadTask[]> {
      return Promise.resolve([...tasks.values()]);
    },

    list(): readonly DownloadTask[] {
      return [...tasks.values()];
    },

    getById(id: string): DownloadTask | undefined {
      return tasks.get(id);
    },

    byState(state: TaskState): readonly DownloadTask[] {
      return [...tasks.values()].filter((task) => task.state === state);
    },

    nextQueued(): DownloadTask | undefined {
      let best: DownloadTask | undefined;
      for (const task of tasks.values()) {
        if (task.state !== 'queued') {
          continue;
        }
        if (best === undefined) {
          best = task;
          continue;
        }
        const priority = task.priority ?? 0;
        const bestPriority = best.priority ?? 0;
        if (
          priority > bestPriority ||
          (priority === bestPriority && task.createdAt < best.createdAt)
        ) {
          best = task;
        }
      }
      return best;
    },

    stats(): QueueStats {
      const count = (state: TaskState): number =>
        [...tasks.values()].filter((task) => task.state === state).length;
      return {
        total: tasks.size,
        queued: count('queued'),
        preparing: count('preparing'),
        active: count('active'),
        paused: count('paused'),
        retrying: count('retrying'),
        canceling: count('canceling'),
        completed: count('completed'),
        failed: count('failed'),
        canceled: count('canceled'),
        removed: count('removed'),
      };
    },

    get size(): number {
      return tasks.size;
    },

    async clear(): Promise<void> {
      tasks.clear();
      await persist();
    },

    async hydrate(): Promise<void> {
      if (repository === undefined) {
        return;
      }
      const stored = await repository.load();
      for (const task of stored) {
        // hydrate() is RECONSTITUTION, not a live transition: it seeds the queue at
        // cold start before any manager transition runs, so it deliberately does not
        // go through assertTransition (every stored state, including completed/failed,
        // is written directly). A job that was mid-flight in a PREVIOUS process has no
        // live native download now (§8.9); its reconstructed initial state for THIS
        // process is 'queued' so it resumes — the stale native id is dropped.
        if (INTERRUPTED_ON_LOAD.has(task.state)) {
          const { nativeDownloadId: _drop, ...rest } = task;
          tasks.set(task.id, { ...rest, state: 'queued' });
        } else if (task.state === 'canceling') {
          // A cancel was in flight when the worker died. NEVER resurrect a
          // cancelled download (hard rule §6) — finalize it to canceled.
          const { nativeDownloadId: _drop, ...rest } = task;
          tasks.set(task.id, { ...rest, state: 'canceled' });
        } else {
          tasks.set(task.id, task);
        }
      }
    },
  };
}
