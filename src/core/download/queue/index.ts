/**
 * Module: core/download/queue
 * Purpose: Persisted download-queue contract — the single source of truth for
 *          download state (PROJECT_BIBLE.md §10.2, §4.4).
 * Restrictions: Domain layer — persistence via repositories (§8.14); no UI.
 * Dependencies: shared/types.
 * Public API: DownloadQueue.
 */
import type { DownloadTask, TaskState } from '@shared/types';

/** Count of jobs by lifecycle state (§10.2). */
export interface QueueStats {
  readonly total: number;
  readonly queued: number;
  readonly preparing: number;
  readonly active: number;
  readonly paused: number;
  readonly retrying: number;
  readonly canceling: number;
  readonly completed: number;
  readonly failed: number;
  readonly canceled: number;
  readonly removed: number;
}

export interface DownloadQueue {
  add(task: DownloadTask): Promise<void>;
  update(task: DownloadTask): Promise<void>;
  remove(taskId: string): Promise<void>;
  all(): Promise<readonly DownloadTask[]>;
  // --- Phase 5 additive: synchronous inspection, scheduling, persistence ---
  /** Synchronous snapshot of all jobs (insertion order). */
  list(): readonly DownloadTask[];
  getById(id: string): DownloadTask | undefined;
  byState(state: TaskState): readonly DownloadTask[];
  /** Next job to schedule: highest priority, FIFO (createdAt) tiebreak, among `queued`. */
  nextQueued(): DownloadTask | undefined;
  stats(): QueueStats;
  readonly size: number;
  clear(): Promise<void>;
  /** Load persisted tasks into memory (rehydrate after suspension, §8.9). */
  hydrate(): Promise<void>;
}
