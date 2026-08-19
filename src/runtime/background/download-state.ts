/**
 * Module: runtime/background/download-state
 * Purpose: Deterministic in-memory runtime state for the background download
 *          runtime (PROJECT_BIBLE.md §8.7, §8.9): hydration status, queue
 *          scheduling status, pending retry schedules, outstanding runtime
 *          operations, and runtime health counters.
 * Restrictions: Runtime layer. This state NEVER mirrors per-job download state —
 *          the persisted queue is the single source of truth for that (§4.4), and
 *          this module holds only what the queue does not: process-local counters
 *          and the retry timers the runtime observes. Pure in-memory, clock
 *          injected for determinism; no browser globals.
 * Public API: RetrySchedule, DownloadRuntimeHealth, DownloadRuntimeState,
 *          createDownloadRuntimeState.
 */

/** A retry the manager has scheduled but not yet fired (§10.4). Runtime-only. */
export interface RetrySchedule {
  readonly taskId: string;
  /** The attempt number that failed, as reported by the manager. */
  readonly attempt: number;
  readonly delayMs: number;
  readonly scheduledAt: number;
}

export interface DownloadRuntimeHealth {
  readonly startedAt: number;
  /** Whether the durable queue has been reconstructed for this process (§8.9). */
  readonly hydrated: boolean;
  /** Jobs restored by the last hydration. */
  readonly hydratedJobs: number;
  /** Whether the queue is currently scheduling transfers (§10.3). */
  readonly scheduling: boolean;
  /** Runtime operations in flight (message handlers + boot). */
  readonly outstanding: number;
  /** Retry timers currently pending. */
  readonly pendingRetries: number;
  readonly enqueued: number;
  readonly started: number;
  readonly completed: number;
  readonly failed: number;
  readonly canceled: number;
  readonly retriesScheduled: number;
  readonly errors: number;
  readonly lastErrorAt: number | undefined;
  readonly lastEventAt: number | undefined;
}

export interface DownloadRuntimeState {
  /** Record a completed hydration and the number of jobs it restored (§8.9). */
  markHydrated(jobs: number): void;
  /** Track whether the queue is scheduling (mirrors queue paused/resumed). */
  setScheduling(scheduling: boolean): void;
  recordEnqueued(count: number): void;
  recordStarted(): void;
  recordCompleted(): void;
  recordFailed(): void;
  recordCanceled(): void;
  /** Record a scheduled retry, replacing any prior schedule for that job. */
  recordRetry(schedule: RetrySchedule): void;
  /** Drop a job's pending retry schedule (fired, cancelled, or finished). */
  clearRetry(taskId: string): void;
  /** Pending retry schedules in insertion order (deterministic). */
  retries(): readonly RetrySchedule[];
  retryFor(taskId: string): RetrySchedule | undefined;
  beginOperation(): void;
  endOperation(): void;
  outstandingCount(): number;
  recordError(): void;
  health(): DownloadRuntimeHealth;
}

export interface DownloadRuntimeStateDeps {
  readonly clock: () => number;
}

export function createDownloadRuntimeState(deps: DownloadRuntimeStateDeps): DownloadRuntimeState {
  const { clock } = deps;
  const retries = new Map<string, RetrySchedule>();
  const startedAt = clock();
  let hydrated = false;
  let hydratedJobs = 0;
  let scheduling = false;
  let outstanding = 0;
  let enqueued = 0;
  let started = 0;
  let completed = 0;
  let failed = 0;
  let canceled = 0;
  let retriesScheduled = 0;
  let errors = 0;
  let lastErrorAt: number | undefined;
  let lastEventAt: number | undefined;

  const touch = (): void => {
    lastEventAt = clock();
  };

  return {
    markHydrated(jobs: number): void {
      hydrated = true;
      hydratedJobs = jobs;
      touch();
    },

    setScheduling(next: boolean): void {
      scheduling = next;
      touch();
    },

    recordEnqueued(count: number): void {
      enqueued += count;
      touch();
    },

    recordStarted(): void {
      started += 1;
      touch();
    },

    recordCompleted(): void {
      completed += 1;
      touch();
    },

    recordFailed(): void {
      failed += 1;
      touch();
    },

    recordCanceled(): void {
      canceled += 1;
      touch();
    },

    recordRetry(schedule: RetrySchedule): void {
      retries.set(schedule.taskId, schedule);
      retriesScheduled += 1;
      touch();
    },

    clearRetry(taskId: string): void {
      retries.delete(taskId);
    },

    retries(): readonly RetrySchedule[] {
      return [...retries.values()];
    },

    retryFor(taskId: string): RetrySchedule | undefined {
      return retries.get(taskId);
    },

    beginOperation(): void {
      outstanding += 1;
    },

    endOperation(): void {
      // Clamp at zero: endOperation is called from `finally` blocks and must stay
      // correct even if a caller unbalances it (§20.7 defensive handlers).
      outstanding = outstanding > 0 ? outstanding - 1 : 0;
    },

    outstandingCount(): number {
      return outstanding;
    },

    recordError(): void {
      errors += 1;
      lastErrorAt = clock();
      touch();
    },

    health(): DownloadRuntimeHealth {
      return {
        startedAt,
        hydrated,
        hydratedJobs,
        scheduling,
        outstanding,
        pendingRetries: retries.size,
        enqueued,
        started,
        completed,
        failed,
        canceled,
        retriesScheduled,
        errors,
        lastErrorAt,
        lastEventAt,
      };
    },
  };
}
