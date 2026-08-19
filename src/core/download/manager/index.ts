/**
 * Module: core/download/manager
 * Purpose: DownloadManager contract — the single authority over all downloads
 *          (PROJECT_BIBLE.md §10.1): lifecycle, queue ownership, scheduling,
 *          progress, retry, cancellation, persistence, and events.
 *          Implementation in ./manager; composition in ../factory.
 * Restrictions: Domain layer — transfers occur ONLY via the injected platform
 *          DownloadsAdapter; no custom HTTP, no chrome/browser, no UI (§10.1, §8.4).
 * Dependencies: shared/types, shared/result, shared/utils, core/download/queue.
 * Public API: EnqueueOptions, QueueState, DownloadEventMap, DownloadManager.
 */
import type { AppError } from '@shared/result';
import type { DownloadTask, MediaItem } from '@shared/types';
import type { Unsubscribe } from '@shared/utils';
import type { QueueStats } from '@core/download/queue';

export type { Unsubscribe } from '@shared/utils';

export interface EnqueueOptions {
  readonly priority?: number;
}

export interface QueueState {
  readonly tasks: readonly DownloadTask[];
}

export interface RetryScheduled {
  readonly task: DownloadTask;
  readonly delayMs: number;
  readonly attempt: number;
}

export interface QueueCompleted {
  readonly completed: number;
  readonly failed: number;
  readonly canceled: number;
}

/** Strongly-typed download lifecycle events (§ Phase 5 events). */
export type DownloadEventMap = {
  readonly 'job:queued': [DownloadTask];
  readonly 'job:preparing': [DownloadTask];
  readonly 'job:started': [DownloadTask];
  readonly progress: [DownloadTask];
  readonly 'job:completed': [DownloadTask];
  readonly 'job:cancelled': [DownloadTask];
  readonly 'job:failed': [DownloadTask];
  readonly 'retry:scheduled': [RetryScheduled];
  readonly 'queue:paused': [];
  readonly 'queue:resumed': [];
  readonly 'queue:completed': [QueueCompleted];
  readonly error: [AppError];
};

export interface DownloadManager {
  enqueue(items: readonly MediaItem[], options?: EnqueueOptions): Promise<readonly DownloadTask[]>;
  cancel(taskId: string): Promise<void>;
  pause(taskId: string): Promise<void>;
  resume(taskId: string): Promise<void>;
  retry(taskId: string): Promise<void>;
  /** Remove a job from the queue (cancels first if active). */
  remove(taskId: string): Promise<void>;
  getQueue(): Promise<readonly DownloadTask[]>;
  /** Synchronous inspection of a single job. */
  getTask(taskId: string): DownloadTask | undefined;
  stats(): QueueStats;
  /** Stop scheduling new jobs (active transfers continue). */
  pauseQueue(): void;
  /** Resume scheduling. */
  resumeQueue(): void;
  /** Cancel all non-terminal jobs and pause scheduling (graceful shutdown). */
  stopQueue(): Promise<void>;
  /** Remove all non-active jobs from the queue. */
  clearQueue(): Promise<void>;
  subscribe(listener: (state: QueueState) => void): Unsubscribe;
  on<K extends keyof DownloadEventMap>(
    event: K,
    listener: (...args: DownloadEventMap[K]) => void,
  ): Unsubscribe;
  /** Release manager resources (detach listeners, clear retry timers). */
  dispose(): Promise<void>;
}
