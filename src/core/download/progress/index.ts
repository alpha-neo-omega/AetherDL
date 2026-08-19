/**
 * Module: core/download/progress
 * Purpose: Progress-tracking contract (PROJECT_BIBLE.md §10.5). Progress is honest:
 *          unknown totals produce no fabricated ratio (§2.8).
 * Restrictions: Domain layer — pure; UI updates throttled downstream (§12).
 * Dependencies: none.
 * Public API: ProgressSnapshot, ProgressTracker.
 */
export interface ProgressSnapshot {
  readonly taskId: string;
  readonly received: number;
  readonly total?: number;
  readonly ratio?: number;
  /** Transfer rate in bytes/sec when derivable from samples (else omitted). */
  readonly bytesPerSec?: number;
  /** Estimated seconds to completion when total and rate are known (else omitted). */
  readonly etaSec?: number;
}

/** Aggregate progress across all tracked jobs. */
export interface OverallProgress {
  readonly received: number;
  readonly total?: number;
  readonly ratio?: number;
  readonly jobs: number;
}

export interface ProgressTracker {
  /** Record a byte sample for a job (drives rate/ETA). */
  record(taskId: string, received: number, total?: number): void;
  snapshot(taskId: string): ProgressSnapshot | undefined;
  /** Aggregate across all tracked jobs. */
  overall(): OverallProgress;
  /** Stop tracking a job. */
  remove(taskId: string): void;
  clear(): void;
}
