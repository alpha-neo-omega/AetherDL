/**
 * Module: core/download/manager (implementation)
 * Purpose: DownloadManager implementation (PROJECT_BIBLE.md §10.1): validated
 *          lifecycle, priority-bounded scheduling, native transfer via the injected
 *          DownloadsAdapter, progress, retry (backoff), cancellation, persistence,
 *          and events. The single authority over downloads.
 * Restrictions: Domain layer — NEVER touches chrome/browser; all transfers go
 *          through the injected DownloadsAdapter (§8.4, §10.8). Deterministic given
 *          injected clock/id/timer. A stream job additionally uses the injected
 *          StreamDeliveryAdapter to turn a manifest into a local URL first — the
 *          write itself still belongs to the browser (§10.6).
 * Public API: DownloadManagerDeps, createDownloadManager.
 */
import { DownloadError, PlatformError } from '@shared/result/errors';
import type { AppError } from '@shared/result';
import type { DownloadTask, HistoryRecord, MediaItem, TaskState } from '@shared/types';
import { TypedEventEmitter } from '@shared/utils';
import type { ConflictAction, DownloadChange, DownloadsAdapter } from '@platform/downloads';
import type { StreamDelivery, StreamDeliveryAdapter } from '@platform/stream';
import type { ConcurrencyLimiter, ReleaseSlot } from '@core/download/concurrency';
import { resolveCollision } from '@core/download/filename/filename';
import type { FilenameGenerator } from '@core/download/filename';
import type { HistoryService } from '@core/history';
import type {
  DownloadEventMap,
  DownloadManager,
  EnqueueOptions,
  QueueState,
  Unsubscribe,
} from '@core/download/manager';
import type { DownloadQueue, QueueStats } from '@core/download/queue';
import type { ProgressTracker } from '@core/download/progress';
import type { RetryPolicy } from '@core/download/retry';
import { assertTransition, TERMINAL_STATES } from '@core/download/state';
import { validateDownloadable } from '@core/download/validate';

/** Cancels a scheduled timer. */
type CancelTimer = () => void;

export interface DownloadManagerDeps {
  readonly downloads: DownloadsAdapter;
  readonly queue: DownloadQueue;
  readonly concurrency: ConcurrencyLimiter;
  readonly retryPolicy: RetryPolicy;
  readonly filename: FilenameGenerator;
  readonly progress: ProgressTracker;
  readonly history?: HistoryService;
  readonly clock: () => number;
  readonly filenameTemplate: string;
  readonly conflictAction: ConflictAction;
  readonly downloadSubfolder?: string;
  /**
   * Assembles a non-encrypted HLS/DASH manifest into a local URL (§10.6). Omitted,
   * or reporting `supported: false`, keeps stream items refused at validation — the
   * behaviour of every build without assembly.
   */
  readonly streamDelivery?: StreamDeliveryAdapter;
  readonly generateId?: () => string;
  readonly scheduleTimer?: (delayMs: number, callback: () => void) => CancelTimer;
}

/**
 * One assembly at a time. Each holds a whole stream in memory, so running the
 * concurrency limit's worth of them in parallel would multiply the peak by that limit
 * (§12.1). Streams therefore queue behind each other even when download slots are
 * free; progressive downloads are unaffected because they never assemble.
 */
const MAX_CONCURRENT_ASSEMBLIES = 1;

/**
 * Persisting a progress patch rewrites the queue (§8.14), and assembly reports once
 * per segment — thousands of times for a long stream. Patches are therefore throttled
 * to this interval; the final segment always lands, so the visible state ends correct.
 */
const STREAM_PROGRESS_INTERVAL_MS = 500;

const SCHEDULABLE: ReadonlySet<TaskState> = new Set<TaskState>([
  'queued',
  'preparing',
  'active',
  'retrying',
  'canceling',
]);

export function createDownloadManager(deps: DownloadManagerDeps): DownloadManager {
  const { downloads, queue, concurrency, retryPolicy, filename, progress, clock } = deps;
  // A subscriber that throws is reported on the manager's own error stream rather
  // than left to a global handler, and the guard stops a throwing `error` listener
  // from reporting itself forever (§20.7).
  let reportingListenerError = false;
  const emitter = new TypedEventEmitter<DownloadEventMap>({
    onListenerError: (cause, event) => {
      if (reportingListenerError) {
        return;
      }
      reportingListenerError = true;
      try {
        emitError(`download-listener-failed-${event}`, cause);
      } finally {
        reportingListenerError = false;
      }
    },
  });
  const generateId = deps.generateId ?? ((): string => crypto.randomUUID());
  const scheduleTimer =
    deps.scheduleTimer ??
    ((ms: number, cb: () => void): CancelTimer => {
      const handle = setTimeout(cb, ms);
      return () => {
        clearTimeout(handle);
      };
    });

  const subscribers = new Set<(state: QueueState) => void>();
  const nativeToJob = new Map<number, string>();
  const releases = new Map<string, ReleaseSlot>();
  const retryTimers = new Map<string, CancelTimer>();
  // Stream jobs only: the assembly in flight (so a cancel can stop the fetches) and
  // the delivered URL (so its bytes are always freed, on every exit path).
  // Per assembling job: how to stop it, and how to hand its assembly slot back. The
  // slot is released on abort as well as on completion — an adapter that never settles
  // after being aborted must not hold the next stream hostage.
  const assemblies = new Map<string, { controller: AbortController; releaseSlot: () => void }>();
  const deliveries = new Map<string, StreamDelivery>();
  // Serializes assemblies: each waiter runs when the one before it settles.
  let assemblyGate: Promise<void> = Promise.resolve();
  let assembliesRunning = 0;
  let queuePaused = false;
  let disposed = false;
  let hadPending = false;

  const notify = (): void => {
    const state: QueueState = { tasks: queue.list() };
    for (const listener of [...subscribers]) {
      listener(state);
    }
  };

  const patch = async (
    task: DownloadTask,
    changes: Partial<DownloadTask>,
  ): Promise<DownloadTask> => {
    const next: DownloadTask = { ...task, ...changes, updatedAt: clock() };
    await queue.update(next);
    notify();
    return next;
  };

  const transition = async (
    task: DownloadTask,
    to: TaskState,
    changes: Partial<DownloadTask> = {},
  ): Promise<DownloadTask> => {
    assertTransition(task.state, to);
    return patch(task, { ...changes, state: to });
  };

  const finishSlot = (jobId: string): void => {
    const release = releases.get(jobId);
    if (release !== undefined) {
      releases.delete(jobId);
      release();
    }
  };

  const streamsSupported = deps.streamDelivery?.supported === true;

  /** Whether this job's source is a manifest this build can assemble (§10.6). */
  const isStreamJob = (item: MediaItem): boolean =>
    streamsSupported && deps.streamDelivery?.handles(item.url) === true;

  const validate = (item: MediaItem): ReturnType<typeof validateDownloadable> =>
    validateDownloadable(item, { allowStreams: streamsSupported });

  /** Free an assembled stream's bytes. Safe to call for a job that had none. */
  const releaseDelivery = (jobId: string): void => {
    const delivery = deliveries.get(jobId);
    if (delivery === undefined) {
      return;
    }
    deliveries.delete(jobId);
    void delivery.release().catch((cause: unknown) => {
      emitError('stream-release-failed', cause);
    });
  };

  /** Stop an assembly still fetching segments (cancel, remove, shutdown). */
  const abortAssembly = (jobId: string): void => {
    const entry = assemblies.get(jobId);
    if (entry !== undefined) {
      assemblies.delete(jobId);
      entry.controller.abort();
      entry.releaseSlot();
    }
  };

  const clearRetryTimer = (jobId: string): void => {
    const cancel = retryTimers.get(jobId);
    if (cancel !== undefined) {
      retryTimers.delete(jobId);
      cancel();
    }
  };

  // Defense in depth: the configured subfolder is untrusted (validated in a later
  // phase). Drop traversal ('..'), absolute anchors (leading '/'), drive letters,
  // and backslashes so it can never escape the browser downloads directory (§13.5).
  const sanitizeSubfolder = (raw: string): string =>
    raw
      .replace(/\\/g, '/')
      .split('/')
      .map((segment) => segment.trim())
      .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
      .map((segment) => segment.replace(/^[A-Za-z]:$/, ''))
      .filter((segment) => segment !== '')
      .join('/');

  const activeFilenames = (excludeId?: string): Set<string> => {
    const names = new Set<string>();
    for (const task of queue.list()) {
      if (task.id === excludeId) {
        continue;
      }
      if (task.state === 'active' || task.state === 'preparing') {
        names.add(task.filename);
      }
    }
    return names;
  };

  /**
   * The container that was actually written. For a stream the detected item says
   * `m3u8`/`mpd` while the saved file is `.ts` or `.mp4`, so the filename — the thing
   * on disk — is the truthful source, with the item's own container as the fallback.
   */
  const savedContainer = (task: DownloadTask): string | undefined => {
    const name = task.filename;
    const dot = name.lastIndexOf('.');
    const fromName = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
    return fromName !== '' ? fromName : task.item.container;
  };

  const recordHistory = (task: DownloadTask, outcome: 'completed' | 'failed'): void => {
    if (deps.history === undefined) {
      return;
    }
    const container = savedContainer(task);
    const record: HistoryRecord = {
      id: task.id,
      title: task.item.title,
      kind: task.item.kind,
      originHost: task.item.originHost,
      timestamp: clock(),
      outcome,
      filename: task.filename,
      ...(container !== undefined && { container }),
      ...(task.bytesTotal !== undefined && { sizeBytes: task.bytesTotal }),
    };
    void deps.history.record(record).catch((cause: unknown) => {
      emitError('history-record-failed', cause);
    });
  };

  const emitError = (code: string, cause: unknown): void => {
    const error =
      cause instanceof PlatformError
        ? cause.toAppError()
        : new DownloadError('Download subsystem error', {
            code,
            messageKey: 'error.download.internal',
            cause,
          }).toAppError();
    emitter.emit('error', error);
  };

  const toDownloadError = (cause: unknown): AppError => {
    if (cause instanceof PlatformError) {
      return cause.toAppError();
    }
    return new DownloadError('Native download failed', {
      code: 'download-native-failed',
      messageKey: 'error.download.native',
      retryable: true,
      cause,
    }).toAppError();
  };

  const checkQueueCompletion = (): void => {
    const pending = queue.list().some((task) => SCHEDULABLE.has(task.state));
    if (pending) {
      hadPending = true;
      return;
    }
    if (hadPending) {
      hadPending = false;
      const stats = queue.stats();
      emitter.emit('queue:completed', {
        completed: stats.completed,
        failed: stats.failed,
        canceled: stats.canceled,
      });
    }
  };

  const handleFailure = async (task: DownloadTask, error: AppError): Promise<void> => {
    // Re-read live state: only a running transfer can fail. A concurrent
    // cancel/pause/complete/remove owns the job otherwise; failing (and retrying) it
    // would be a forbidden transition and could retry/resurrect a cancelled or
    // removed job (§6, §10.2). Bail if it left the queue — never re-insert it.
    const current = queue.getById(task.id);
    if (current === undefined || (current.state !== 'active' && current.state !== 'preparing')) {
      return;
    }
    const failed = await transition(current, 'failed', { error, completedAt: clock() });
    if (current.nativeDownloadId !== undefined) {
      nativeToJob.delete(current.nativeDownloadId);
    }
    progress.remove(current.id);
    finishSlot(current.id);
    releaseDelivery(current.id);
    // Drop any prior retry timer before (re)scheduling so it cannot leak.
    clearRetryTimer(current.id);
    const decision = retryPolicy.shouldRetry(error, current.attempt);
    if (decision.retry) {
      const retrying = await transition(failed, 'retrying');
      emitter.emit('retry:scheduled', {
        task: retrying,
        delayMs: decision.delayMs,
        attempt: current.attempt,
      });
      retryTimers.set(
        current.id,
        scheduleTimer(decision.delayMs, () => {
          void requeueAfterRetry(current.id);
        }),
      );
    } else {
      recordHistory(failed, 'failed');
      emitter.emit('job:failed', failed);
    }
  };

  const requeueAfterRetry = async (jobId: string): Promise<void> => {
    retryTimers.delete(jobId);
    const job = queue.getById(jobId);
    if (job === undefined || job.state !== 'retrying') {
      return;
    }
    await transition(job, 'queued', { attempt: job.attempt + 1 });
    pump();
  };

  const completeJob = async (jobId: string): Promise<void> => {
    const job = queue.getById(jobId);
    // Only a live 'active' job may complete. A concurrent cancel/pause (→canceling
    // /paused/terminal) owns the job otherwise; completing it would be a forbidden
    // transition (e.g. canceling→completed) and would resurrect a cancelled job.
    if (job === undefined || job.state !== 'active') {
      return;
    }
    const done = await transition(job, 'completed', {
      completedAt: clock(),
      progress: 1,
      ...(job.bytesTotal !== undefined && { bytesReceived: job.bytesTotal }),
    });
    if (job.nativeDownloadId !== undefined) {
      nativeToJob.delete(job.nativeDownloadId);
    }
    progress.remove(jobId);
    finishSlot(jobId);
    // The browser has the file now; the blob behind the URL is dead weight (§12.1).
    releaseDelivery(jobId);
    recordHistory(done, 'completed');
    emitter.emit('job:completed', done);
    pump();
    checkQueueCompletion();
  };

  const handleChange = async (change: DownloadChange): Promise<void> => {
    const jobId = nativeToJob.get(change.id);
    if (jobId === undefined) {
      return;
    }
    // Only a live 'active' job reacts to native events (fast pre-check).
    if (queue.getById(jobId)?.state !== 'active') {
      return;
    }

    // Enrich progress from the adapter (bytes are not carried on the change event).
    let snapshotState = change.state;
    let sample:
      { readonly received: number | undefined; readonly total: number | undefined } | undefined;
    try {
      const p = await downloads.getProgress(change.id);
      if (p !== undefined) {
        snapshotState = p.state ?? change.state;
        sample = { received: p.bytesReceived, total: p.bytesTotal };
      }
    } catch (cause) {
      emitError('download-progress-failed', cause);
    }

    // Re-read AFTER the await: a concurrent cancel/pause may have moved the job out
    // of 'active'. Never patch/complete/fail a job that is no longer active, or a
    // stale snapshot would resurrect it into a live/terminal state (§10.2).
    const job = queue.getById(jobId);
    if (job === undefined || job.state !== 'active') {
      return;
    }
    let updated = job;
    if (sample !== undefined) {
      const received = sample.received ?? job.bytesReceived ?? 0;
      progress.record(jobId, received, sample.total);
      const ratio = progress.snapshot(jobId)?.ratio;
      updated = await patch(job, {
        bytesReceived: received,
        ...(sample.total !== undefined && { bytesTotal: sample.total }),
        ...(ratio !== undefined && { progress: ratio }),
      });
    }

    if (snapshotState === 'completed') {
      await completeJob(jobId);
    } else if (snapshotState === 'failed') {
      await handleFailure(updated, toDownloadError(new Error('Native download interrupted')));
      pump();
      checkQueueCompletion();
    } else {
      emitter.emit('progress', updated);
    }
  };

  /**
   * Replace a name's extension. A manifest URL ends in `.m3u8`/`.mpd`, so the name
   * generated at enqueue names the playlist, not the video; only after assembly is
   * the real container known (§10.7).
   */
  const withExtension = (name: string, extension: string): string => {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    return `${base}.${extension}`;
  };

  /**
   * Assemble a manifest into a local URL, reporting segment progress on the job as
   * it goes. Throws on refusal (encryption above all) or failure; the caller's catch
   * turns that into the normal failure path (§10.6, §6).
   */
  /** Wait for a free assembly slot, keeping the queue's order (§10.6, §12.1). */
  const acquireAssemblySlot = async (): Promise<() => void> => {
    while (assembliesRunning >= MAX_CONCURRENT_ASSEMBLIES) {
      await assemblyGate;
    }
    assembliesRunning += 1;
    let release = (): void => undefined;
    assemblyGate = new Promise<void>((resolve) => {
      release = (): void => {
        resolve();
      };
    });
    // Idempotent: abort and completion may both reach for it.
    let handed = false;
    return () => {
      if (handed) {
        return;
      }
      handed = true;
      assembliesRunning -= 1;
      release();
    };
  };

  const assembleStreamFor = async (job: DownloadTask): Promise<StreamDelivery> => {
    const adapter = deps.streamDelivery;
    if (adapter === undefined) {
      throw new DownloadError('This build cannot assemble streams', {
        code: 'stream-unsupported',
        messageKey: 'error.download.stream',
      });
    }
    const controller = new AbortController();
    let lastPatchAt = 0;
    const releaseAssemblySlot = await acquireAssemblySlot();
    assemblies.set(job.id, { controller, releaseSlot: releaseAssemblySlot });
    try {
      const delivery = await adapter.assemble({
        manifestUrl: job.item.url,
        signal: controller.signal,
        onProgress: (progressReport): void => {
          // Only a job still preparing may be patched: a concurrent cancel/remove
          // owns it otherwise, and a stale patch would resurrect it (§10.2).
          const live = queue.getById(job.id);
          if (live === undefined || live.state !== 'preparing') {
            return;
          }
          // Throttled: one write per interval, plus the last segment unconditionally,
          // so a 20 000-segment stream does not rewrite the queue 20 000 times.
          const now = clock();
          const isLast = progressReport.segmentsDone >= progressReport.segmentsTotal;
          if (!isLast && lastPatchAt !== 0 && now - lastPatchAt < STREAM_PROGRESS_INTERVAL_MS) {
            return;
          }
          lastPatchAt = now;
          const ratio =
            progressReport.segmentsTotal > 0
              ? progressReport.segmentsDone / progressReport.segmentsTotal
              : 0;
          void patch(live, {
            bytesReceived: progressReport.bytesReceived,
            progress: ratio,
          }).then(
            (updated) => {
              emitter.emit('progress', updated);
            },
            (cause: unknown) => {
              emitError('stream-progress-failed', cause);
            },
          );
        },
      });
      deliveries.set(job.id, delivery);
      return delivery;
    } finally {
      assemblies.delete(job.id);
      releaseAssemblySlot();
    }
  };

  const startJob = async (job: DownloadTask, release: ReleaseSlot): Promise<void> => {
    releases.set(job.id, release);
    const prepared = await transition(job, 'preparing');
    emitter.emit('job:preparing', prepared);
    try {
      // A stream is fetched and joined first; what the browser then saves is the
      // assembled local file, never the playlist (§10.6).
      const delivery = isStreamJob(prepared.item) ? await assembleStreamFor(prepared) : undefined;
      // A cancel during assembly already finalized the job; do not start a transfer
      // for it, and free the bytes the assembly produced.
      const afterAssembly = queue.getById(job.id);
      if (
        delivery !== undefined &&
        (afterAssembly === undefined || afterAssembly.state !== 'preparing')
      ) {
        releaseDelivery(job.id);
        finishSlot(job.id);
        pump();
        checkQueueCompletion();
        return;
      }
      // Exclude THIS job from the collision set — it was just persisted as
      // 'preparing', so including it would make every download self-collide (§10.7).
      const generated =
        delivery === undefined
          ? prepared.filename
          : withExtension(prepared.filename, delivery.extension);
      const name = resolveCollision(generated, activeFilenames(job.id));
      const subfolder =
        deps.downloadSubfolder !== undefined ? sanitizeSubfolder(deps.downloadSubfolder) : '';
      const target = subfolder !== '' ? `${subfolder}/${name}` : name;
      const nativeId = await downloads.start({
        url: delivery?.url ?? prepared.item.url,
        filename: target,
        conflictAction: deps.conflictAction,
        saveAs: false,
      });
      const current = queue.getById(job.id);
      if (current === undefined || current.state === 'canceling' || current.state === 'canceled') {
        releaseDelivery(job.id);
        await downloads.cancel(nativeId).catch(() => undefined);
        // Re-read AFTER the cancel await: a concurrent cancelJob/removeJob may have
        // finalized the job already. Only finalize (and emit) if it is still
        // 'canceling', else we would double-emit or resurrect a removed job.
        const settled = queue.getById(job.id);
        if (settled !== undefined && settled.state === 'canceling') {
          const canceled = await transition(settled, 'canceled', { completedAt: clock() });
          emitter.emit('job:cancelled', canceled);
        }
        finishSlot(job.id);
        pump();
        checkQueueCompletion();
        return;
      }
      nativeToJob.set(nativeId, job.id);
      const active = await transition(current, 'active', {
        nativeDownloadId: nativeId,
        filename: name,
        startedAt: clock(),
        // For a stream the total is known exactly once assembly finishes, which is
        // more than the native adapter can report for a blob URL (§10.5).
        ...(delivery !== undefined && { bytesTotal: delivery.byteLength }),
      });
      emitter.emit('job:started', active);
    } catch (cause) {
      // Assembly or start failed: the assembled bytes are useless now, and a retry
      // assembles again from scratch.
      releaseDelivery(job.id);
      // Use the LIVE job; if a concurrent remove dropped it, never resurrect it via
      // the stale `prepared` snapshot — just release the slot.
      const live = queue.getById(job.id);
      if (live !== undefined) {
        await handleFailure(live, toDownloadError(cause));
      } else {
        finishSlot(job.id);
      }
      pump();
      checkQueueCompletion();
    }
  };

  const pump = (): void => {
    // Track that work exists so queue:completed can fire once the queue drains.
    if (queue.list().some((task) => SCHEDULABLE.has(task.state))) {
      hadPending = true;
    }
    if (disposed || queuePaused) {
      return;
    }
    for (;;) {
      const job = queue.nextQueued();
      if (job === undefined) {
        break;
      }
      const release = concurrency.tryAcquire();
      if (release === undefined) {
        break;
      }
      void startJob(job, release);
    }
  };

  const unsubDownloads = downloads.onChanged((change) => {
    void handleChange(change);
  });

  const createJob = (item: MediaItem, priority: number, index: number): DownloadTask => {
    const name = filename.generate(item, deps.filenameTemplate, index);
    return {
      id: generateId(),
      item,
      state: 'queued',
      filename: name,
      originalFilename: name,
      attempt: 0,
      priority,
      createdAt: clock(),
      updatedAt: clock(),
    };
  };

  const cancelJob = async (taskId: string): Promise<void> => {
    const job = queue.getById(taskId);
    if (job === undefined || job.state === 'failed' || TERMINAL_STATES.has(job.state)) {
      return;
    }
    clearRetryTimer(taskId);
    // A stream job may be mid-assembly with no native transfer yet: the fetches are
    // ours to stop, and the bytes ours to drop (§10.10).
    abortAssembly(taskId);
    if (job.state === 'active' || job.state === 'preparing' || job.state === 'canceling') {
      // Route through 'canceling' (valid from active/preparing). A 'preparing' job
      // may have no native id yet (startJob still awaiting downloads.start) —
      // preparing→canceled is NOT a legal edge, so we must go via 'canceling'.
      if (job.state !== 'canceling') {
        await transition(job, 'canceling');
      }
      if (job.nativeDownloadId !== undefined) {
        await downloads.cancel(job.nativeDownloadId).catch(() => undefined);
        nativeToJob.delete(job.nativeDownloadId);
      }
      // startJob (resuming from its start() await) may finalize a preparing job
      // first; only finalize here if it is still 'canceling'.
      const current = queue.getById(taskId);
      if (current !== undefined && current.state === 'canceling') {
        const canceled = await transition(current, 'canceled', { completedAt: clock() });
        progress.remove(taskId);
        finishSlot(taskId);
        releaseDelivery(taskId);
        emitter.emit('job:cancelled', canceled);
      }
    } else {
      // queued / paused / retrying — no native transfer to stop.
      const canceled = await transition(job, 'canceled', { completedAt: clock() });
      progress.remove(taskId);
      releaseDelivery(taskId);
      emitter.emit('job:cancelled', canceled);
    }
    pump();
    checkQueueCompletion();
  };

  const removeJob = async (taskId: string): Promise<void> => {
    const initial = queue.getById(taskId);
    if (initial === undefined) {
      return;
    }
    clearRetryTimer(taskId);
    abortAssembly(taskId);
    if (
      initial.nativeDownloadId !== undefined &&
      (initial.state === 'active' || initial.state === 'preparing' || initial.state === 'canceling')
    ) {
      await downloads.cancel(initial.nativeDownloadId).catch(() => undefined);
      nativeToJob.delete(initial.nativeDownloadId);
    }
    // Re-read AFTER the cancel await: a concurrent complete/cancel may have finalized
    // (or removed) the job. Drive it to 'removed' only through legal edges from its
    // LIVE state — never assert a transition off a stale snapshot (§10.2).
    let job = queue.getById(taskId);
    if (job === undefined) {
      return;
    }
    if (job.state === 'active' || job.state === 'preparing') {
      job = await transition(job, 'canceling');
    }
    if (job.state === 'canceling') {
      job = await transition(job, 'canceled', { completedAt: clock() });
      finishSlot(taskId);
    }
    job = await transition(job, 'removed');
    await queue.remove(taskId);
    progress.remove(taskId);
    releaseDelivery(taskId);
    notify();
    pump();
    checkQueueCompletion();
  };

  return {
    async enqueue(
      items: readonly MediaItem[],
      options?: EnqueueOptions,
    ): Promise<readonly DownloadTask[]> {
      const priority = options?.priority ?? 0;
      const created: DownloadTask[] = [];
      let index = 0;
      for (const item of items) {
        const job = createJob(item, priority, index);
        index += 1;
        const validation = validate(item);
        if (validation.ok) {
          await queue.add(job);
          emitter.emit('job:queued', job);
          created.push(job);
        } else {
          const appError = validation.error.toAppError();
          const failed: DownloadTask = {
            ...job,
            state: 'failed',
            error: appError,
            completedAt: clock(),
          };
          await queue.add(failed);
          emitter.emit('error', appError);
          emitter.emit('job:failed', failed);
          created.push(failed);
        }
      }
      notify();
      pump();
      return created;
    },

    cancel(taskId: string): Promise<void> {
      return cancelJob(taskId);
    },

    async pause(taskId: string): Promise<void> {
      const job = queue.getById(taskId);
      if (job === undefined) {
        return;
      }
      // A job still assembling has no native transfer to park, and `preparing` cannot
      // go straight to `paused` (§10.2). Route it the same way an active job is
      // paused — through `canceling` — stopping the fetches and dropping the partial
      // bytes; a resume starts the assembly again from the beginning.
      if (job.state === 'preparing' && assemblies.has(taskId)) {
        const canceling = await transition(job, 'canceling');
        abortAssembly(taskId);
        releaseDelivery(taskId);
        finishSlot(taskId);
        // Re-read AFTER the transition: a concurrent cancel/remove may own the job by
        // now, and parking it would resurrect what the user just discarded.
        const settled = queue.getById(taskId);
        if (settled !== undefined && settled.state === 'canceling') {
          await transition(settled, 'paused');
        } else {
          void canceling;
        }
        pump();
        return;
      }
      if (job.state === 'queued') {
        await transition(job, 'paused');
      } else if (job.state === 'active' && job.nativeDownloadId !== undefined) {
        await transition(job, 'canceling');
        await downloads.cancel(job.nativeDownloadId).catch(() => undefined);
        nativeToJob.delete(job.nativeDownloadId);
        finishSlot(taskId);
        // Re-read AFTER the cancel await: a concurrent cancel/remove may have already
        // driven the job to a terminal state. Only park it if it is still
        // 'canceling', else we would resurrect a cancelled/removed download.
        const settled = queue.getById(taskId);
        if (settled === undefined || settled.state !== 'canceling') {
          return;
        }
        await transition(settled, 'paused');
      } else {
        return;
      }
      pump();
    },

    async resume(taskId: string): Promise<void> {
      const job = queue.getById(taskId);
      if (job === undefined || job.state !== 'paused') {
        return;
      }
      await transition(job, 'queued');
      pump();
    },

    async retry(taskId: string): Promise<void> {
      const job = queue.getById(taskId);
      if (job === undefined || job.state !== 'failed') {
        return;
      }
      // NEVER resurrect a job that failed validation or is non-retryable (§6):
      // DRM/unsupported, blob, or invalid URLs — and stream manifests too in a build
      // that cannot assemble them. Manual retry() must apply the same gate as the
      // automatic path (which uses retryPolicy.shouldRetry).
      if (job.error !== undefined && !job.error.retryable) {
        return;
      }
      if (!validate(job.item).ok) {
        return;
      }
      clearRetryTimer(taskId);
      await transition(job, 'queued', { attempt: 0 });
      pump();
    },

    remove(taskId: string): Promise<void> {
      return removeJob(taskId);
    },

    getQueue(): Promise<readonly DownloadTask[]> {
      return queue.all();
    },

    getTask(taskId: string): DownloadTask | undefined {
      return queue.getById(taskId);
    },

    stats(): QueueStats {
      return queue.stats();
    },

    pauseQueue(): void {
      if (!queuePaused) {
        queuePaused = true;
        emitter.emit('queue:paused');
      }
    },

    resumeQueue(): void {
      if (queuePaused) {
        queuePaused = false;
        emitter.emit('queue:resumed');
        pump();
      }
    },

    async stopQueue(): Promise<void> {
      queuePaused = true;
      emitter.emit('queue:paused');
      for (const task of queue.list()) {
        if (SCHEDULABLE.has(task.state) && task.state !== 'canceling') {
          await cancelJob(task.id);
        }
      }
    },

    async clearQueue(): Promise<void> {
      for (const task of queue.list()) {
        if (task.state !== 'active' && task.state !== 'preparing' && task.state !== 'canceling') {
          await removeJob(task.id);
        }
      }
    },

    subscribe(listener: (state: QueueState) => void): Unsubscribe {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },

    on<K extends keyof DownloadEventMap>(
      event: K,
      listener: (...args: DownloadEventMap[K]) => void,
    ): Unsubscribe {
      return emitter.on(event, listener);
    },

    async dispose(): Promise<void> {
      disposed = true;
      unsubDownloads();
      for (const entry of assemblies.values()) {
        entry.controller.abort();
        entry.releaseSlot();
      }
      assemblies.clear();
      for (const jobId of [...deliveries.keys()]) {
        releaseDelivery(jobId);
      }
      for (const cancel of retryTimers.values()) {
        cancel();
      }
      retryTimers.clear();
      progress.clear();
      subscribers.clear();
      emitter.clear();
      await Promise.resolve();
    },
  };
}
