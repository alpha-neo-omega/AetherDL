/**
 * Module: runtime/background/downloads
 * Purpose: The background download runtime (PROJECT_BIBLE.md §8.9, §10.1) — the
 *          composition that makes the background the SOLE owner of the Download
 *          Manager, the queue, the download repository, progress forwarding, retry
 *          scheduling, and queue lifecycle. It wires the EXISTING download system
 *          (built through `core/download/factory`) to platform services: typed
 *          `download/*` message handlers, browser lifecycle, permission validation,
 *          runtime download state, and one forwarded event stream.
 * Restrictions: Runtime layer — thin orchestration only. No download algorithm, no
 *          Download Manager internals, and no second event system live here. Browser
 *          access goes through the injected Browser facade (§8.4); no `chrome`/
 *          `browser` globals. Handlers are defensive and idempotent (§20.7); every
 *          listener is detached on dispose (§12.8).
 * Public API: DOWNLOAD_EVENT_CHANNEL, DownloadRuntimeEventMap, MediaItemResolver,
 *          createDetectionItemResolver, DownloadRuntimeSnapshot,
 *          BackgroundDownloadRuntime, BackgroundDownloadRuntimeDeps,
 *          createBackgroundDownloadRuntime.
 */
import type { Browser } from '@platform/browser';
import type { StreamDeliveryAdapter } from '@platform/stream';
import type { ObjectStore } from '@platform/storage';
import { createQueueRepository } from '@core/storage/queue-repository';
import { DownloadValidationError, PermissionDeniedError } from '@core/download/errors';
import { createDownloadSystem, type ConfigurableDownloadManager } from '@core/download/factory';
import { resolveStreamDelivery } from '@runtime/background/stream';
import type { QueueCompleted, RetryScheduled } from '@core/download/manager';
import { createDownloadQueue } from '@core/download/queue/queue';
import type { DownloadQueue, QueueStats } from '@core/download/queue';
import type { HistoryService } from '@core/history';
import { DOWNLOAD_EVENT_CHANNEL } from '@shared/constants';
import type { AppError } from '@shared/result';
import { PlatformError, RuntimeError } from '@shared/result/errors';
import type {
  DownloadEventBroadcast,
  DownloadEventName,
  DownloadProgressSnapshot,
  DownloadTask,
  Settings,
  MediaItem,
  TaskState,
} from '@shared/types';
import { parseUrl, TypedEventEmitter, type Unsubscribe } from '@shared/utils';
import {
  createDownloadRuntimeState,
  type DownloadRuntimeHealth,
  type DownloadRuntimeState,
  type RetrySchedule,
} from '@runtime/background/download-state';
import type { RuntimeState } from '@runtime/background/state';

/**
 * Broadcast channel (background → surfaces) carrying download lifecycle events.
 * Re-exported from the leaf layer so a surface can subscribe without importing
 * background code (§8.16); the name and this import path are unchanged.
 */
export { DOWNLOAD_EVENT_CHANNEL } from '@shared/constants';

/** The install-time permission every transfer depends on (§13.3). */
const DOWNLOADS_PERMISSION = 'downloads';

/** Jobs whose transfer has not settled — the set `download/progress` reports. */
const IN_FLIGHT_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'queued',
  'preparing',
  'active',
  'paused',
  'retrying',
  'canceling',
]);

/**
 * Forwarded Download Manager events (single stream, §8.5). Every member mirrors an
 * event the manager already emits; the runtime adds no lifecycle of its own.
 */
export type DownloadRuntimeEventMap = {
  readonly 'download:queued': [DownloadTask];
  readonly 'download:preparing': [DownloadTask];
  readonly 'download:started': [DownloadTask];
  readonly 'download:progress': [DownloadTask];
  readonly 'download:completed': [DownloadTask];
  readonly 'download:failed': [DownloadTask];
  readonly 'download:cancelled': [DownloadTask];
  readonly 'retry:scheduled': [RetryScheduled];
  readonly 'queue:paused': [];
  readonly 'queue:resumed': [];
  readonly 'queue:completed': [QueueCompleted];
  readonly error: [AppError];
};

/** The forwarded events that carry a job (the rest carry queue-level payloads). */
type DownloadTaskEventName = Extract<
  DownloadEventName,
  | 'download:queued'
  | 'download:preparing'
  | 'download:started'
  | 'download:progress'
  | 'download:completed'
  | 'download:failed'
  | 'download:cancelled'
>;

/** Resolves `download/enqueue` identity keys to detected media items (§8.6). */
export interface MediaItemResolver {
  resolve(itemIds: readonly string[]): readonly MediaItem[];
}

/**
 * Resolve enqueue ids against the background's per-tab detection results — the
 * background-owned source of truth the popup reads (§8.7). Ids are stable identity
 * keys (§9.5), so the first tab holding an id wins and the scan is deterministic.
 */
export function createDetectionItemResolver(state: RuntimeState): MediaItemResolver {
  return {
    resolve(itemIds: readonly string[]): readonly MediaItem[] {
      const wanted = new Set(itemIds);
      const found = new Map<string, MediaItem>();
      for (const tab of state.tabs()) {
        for (const item of state.getItems(tab.tabId)) {
          if (wanted.has(item.id) && !found.has(item.id)) {
            found.set(item.id, item);
          }
        }
      }
      // Preserve the caller's order so enqueue order is deterministic.
      const resolved: MediaItem[] = [];
      for (const id of wanted) {
        const item = found.get(id);
        if (item !== undefined) {
          resolved.push(item);
        }
      }
      return resolved;
    },
  };
}

/** Deterministic view of runtime download state (§8.7). */
export interface DownloadRuntimeSnapshot {
  /** Job counts read from the queue — the single source of truth (§4.4). */
  readonly stats: QueueStats;
  readonly health: DownloadRuntimeHealth;
  readonly retries: readonly RetrySchedule[];
}

export interface BackgroundDownloadRuntime {
  /** Register handlers + listeners (synchronously at top level, §8.9). */
  start(): void;
  /**
   * Enqueue detected media by identity key from inside the background — the same
   * path the `download/enqueue` handler takes, including the permission gate and
   * the manager's validation. Phase 7 additive, for the context-menu integration
   * (§4.13); no existing member changed.
   */
  enqueue(itemIds: readonly string[]): Promise<void>;
  /** Resolves once the durable queue is reconstructed and scheduling is live. */
  ready(): Promise<void>;
  /**
   * Apply an already-validated settings catalogue to the running Download System
   * (§4.9 settings apply live). The composition root calls this from the settings
   * runtime's `settings:changed` event — the existing mechanism; no new message
   * family, no second settings source.
   */
  applySettings(settings: Settings): void;
  on<K extends keyof DownloadRuntimeEventMap>(
    event: K,
    listener: (...args: DownloadRuntimeEventMap[K]) => void,
  ): Unsubscribe;
  /** Read-only runtime state (for surfaces/diagnostics). */
  readonly state: DownloadRuntimeState;
  snapshot(): DownloadRuntimeSnapshot;
  /** Detach every listener/handler and release manager resources (§12.8). */
  dispose(): Promise<void>;
}

export interface BackgroundDownloadRuntimeDeps {
  readonly browser: Browser;
  /** Turns enqueue ids into detected media items (§8.6). */
  readonly resolver: MediaItemResolver;
  /**
   * The structured store backing the download repository (§8.14). The runtime wraps
   * it in the durable queue repository it owns, so storage failures surface on this
   * runtime's own error stream.
   */
  readonly store: ObjectStore<unknown>;
  readonly history?: HistoryService;
  /**
   * Reads the applied settings catalogue (§4.9). The background already owns the
   * settings service; this runtime holds no copy of it and never persists settings —
   * it only forwards the download-related values into the Download System it built
   * (§8.7). Omitted, the system keeps its normative defaults.
   */
  readonly getSettings?: () => Promise<Settings>;
  /**
   * How HLS/DASH manifests become files (§10.6). Omitted, the runtime resolves the
   * adapter this engine supports; pass `null` to run with assembly off, which keeps
   * stream items refused exactly as a build without it.
   */
  readonly streamDelivery?: StreamDeliveryAdapter | null;
  readonly clock?: () => number;
  readonly generateId?: () => string;
  readonly random?: () => number;
  readonly scheduleTimer?: (delayMs: number, callback: () => void) => () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Extract a valid task id from an untrusted request payload (§13.8). */
function extractTaskId(request: unknown): string | undefined {
  if (!isRecord(request)) {
    return undefined;
  }
  const taskId = request['taskId'];
  return typeof taskId === 'string' && taskId !== '' ? taskId : undefined;
}

/** Extract deduplicated, non-empty item ids from an untrusted payload (§13.8). */
function extractItemIds(request: unknown): readonly string[] | undefined {
  if (!isRecord(request)) {
    return undefined;
  }
  const raw = request['itemIds'];
  if (!Array.isArray(raw)) {
    return undefined;
  }
  return [...new Set(raw.filter((id): id is string => typeof id === 'string' && id !== ''))];
}

/** Compact wire view of a job's transfer progress (§10.5). */
function toProgressSnapshot(task: DownloadTask): DownloadProgressSnapshot {
  return {
    taskId: task.id,
    state: task.state,
    filename: task.filename,
    ...(task.bytesReceived !== undefined && { bytesReceived: task.bytesReceived }),
    ...(task.bytesTotal !== undefined && { bytesTotal: task.bytesTotal }),
    ...(task.progress !== undefined && { progress: task.progress }),
  };
}

/** Strip local-only diagnostics before an error crosses a context boundary (§20.5). */
function toWireError(error: AppError): AppError {
  return {
    category: error.category,
    code: error.code,
    messageKey: error.messageKey,
    retryable: error.retryable,
  };
}

export function createBackgroundDownloadRuntime(
  deps: BackgroundDownloadRuntimeDeps,
): BackgroundDownloadRuntime {
  const { browser, resolver } = deps;
  const clock = deps.clock ?? ((): number => Date.now());
  const emitter = new TypedEventEmitter<DownloadRuntimeEventMap>();
  const state = createDownloadRuntimeState({ clock });

  const unsubscribes: Unsubscribe[] = [];
  let started = false;
  let disposed = false;
  let booting: Promise<void> | undefined;

  const broadcast = (payload: DownloadEventBroadcast): void => {
    void browser.messaging.broadcast(DOWNLOAD_EVENT_CHANNEL, payload).catch(() => undefined);
  };

  const publishError = (error: AppError): void => {
    state.recordError();
    emitter.emit('error', error);
    broadcast({ event: 'error', error: toWireError(error) });
  };

  // The background owns the download repository, exactly one queue, and exactly one
  // Download Manager, built through the existing composition root (§10.1). It owns
  // the queue itself so it can reconstruct it before scheduling resumes (§8.9); the
  // manager's internals are never reached into.
  const repository = createQueueRepository({ store: deps.store, onError: publishError });
  const queue: DownloadQueue = createDownloadQueue({ repository });
  const streamDelivery =
    deps.streamDelivery === null
      ? undefined
      : (deps.streamDelivery ?? resolveStreamDelivery(browser));
  const manager: ConfigurableDownloadManager = createDownloadSystem({
    downloads: browser.downloads,
    queue,
    clock,
    ...(streamDelivery !== undefined && { streamDelivery }),
    ...(deps.history !== undefined && { history: deps.history }),
    ...(deps.generateId !== undefined && { generateId: deps.generateId }),
    ...(deps.random !== undefined && { random: deps.random }),
    ...(deps.scheduleTimer !== undefined && { scheduleTimer: deps.scheduleTimer }),
  });

  /** Normalize a thrown value to a typed error; a typed error keeps its own code. */
  const toRuntimeError = (code: string, cause: unknown): PlatformError =>
    cause instanceof PlatformError
      ? cause
      : new RuntimeError('Background download runtime error', {
          code,
          messageKey: 'error.runtime.download',
          cause,
        });

  const emitError = (code: string, cause: unknown): void => {
    publishError(toRuntimeError(code, cause).toAppError());
  };

  const emitTask = (event: DownloadTaskEventName, task: DownloadTask): void => {
    emitter.emit(event, task);
    broadcast({ event, task: toProgressSnapshot(task) });
  };

  /**
   * Reconstruct the durable queue, then release scheduling (§8.9). Memoized: a cold
   * start, a lifecycle event, and the first message all converge on one boot. Never
   * rejects — a storage failure is reported and the runtime continues in-memory so a
   * broken store cannot take the background down (§20.7).
   */
  /** Push the download-related settings into the running system (§4.9, §10.3). */
  const applySettings = (settings: Settings): void => {
    manager.configure({
      maxConcurrent: settings.maxConcurrentDownloads,
      maxRetries: settings.maxRetries,
      filenameTemplate: settings.filenameTemplate,
      downloadSubfolder: settings.downloadSubfolder,
    });
  };

  const boot = async (): Promise<void> => {
    state.beginOperation();
    try {
      // Configure BEFORE scheduling resumes, so the first job of the session already
      // runs under the user's settings rather than the defaults (§4.9, §8.9).
      const settings = await deps.getSettings?.();
      if (settings !== undefined) {
        applySettings(settings);
      }
    } catch (cause) {
      emitError('download-settings-read-failed', cause);
    } finally {
      state.endOperation();
    }
    state.beginOperation();
    try {
      await queue.hydrate();
      state.markHydrated(queue.size);
    } catch (cause) {
      emitError('download-queue-hydrate-failed', cause);
    } finally {
      state.endOperation();
    }
    // A previous worker generation may have left an offscreen document open, holding
    // a stream-sized blob nothing tracks any more (§8.9, §12.1).
    if (streamDelivery?.reset !== undefined) {
      try {
        await streamDelivery.reset();
      } catch (cause) {
        emitError('stream-reset-failed', cause);
      }
    }
    // Pause is idempotent and guarantees the resume below actually pumps, so jobs
    // interrupted by a previous teardown restart from their reconstructed state
    // even if boot ran without `start()` having held scheduling (§8.9, §15.8).
    manager.pauseQueue();
    manager.resumeQueue();
  };

  const ensureReady = (): Promise<void> => {
    booting ??= boot();
    return booting;
  };

  /** Run a handler body with outstanding-operation accounting and error reporting. */
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    state.beginOperation();
    try {
      return await operation();
    } catch (cause) {
      // Report locally for observability, then propagate so the caller sees an
      // honest failure rather than a silent success (§2.8, §20.5). Propagating the
      // typed error keeps the code the surface receives stable.
      const error = toRuntimeError('download-operation-failed', cause);
      publishError(error.toAppError());
      throw error;
    } finally {
      state.endOperation();
    }
  };

  /**
   * Verify the browser still grants `downloads` before a transfer is queued (§4.15).
   * AetherDL declares `downloads` at install and NEVER re-requests it (§13.1); a
   * revoked permission is reported, never re-prompted. A failing *query* is reported
   * but does not block: the native start path surfaces a real permission failure on
   * its own, and refusing on a diagnostic error would disable downloads on a target
   * whose permissions query misbehaves (§7.2).
   */
  const hasDownloadPermission = async (): Promise<boolean> => {
    try {
      return await browser.permissions.contains([DOWNLOADS_PERMISSION]);
    } catch (cause) {
      emitError('download-permission-check-failed', cause);
      return true;
    }
  };

  /** `https://cdn.example/*` for a manifest URL; nothing for anything else. */
  const streamOriginOf = (item: MediaItem): string | undefined => {
    if (streamDelivery?.handles(item.url) !== true) {
      return undefined;
    }
    const parsed = parseUrl(item.url);
    return parsed === undefined ? undefined : `${parsed.origin}/*`;
  };

  /**
   * Keep the items whose hosts are granted, asking for the ones that are not. Items
   * left without access are dropped with a reported reason; everything else proceeds,
   * so one declined stream never blocks the rest of a batch.
   */
  const withStreamHostAccess = async (
    items: readonly MediaItem[],
  ): Promise<readonly MediaItem[]> => {
    const origins = new Map<string, MediaItem[]>();
    for (const item of items) {
      const origin = streamOriginOf(item);
      if (origin === undefined) {
        continue;
      }
      const group = origins.get(origin) ?? [];
      group.push(item);
      origins.set(origin, group);
    }
    if (origins.size === 0) {
      return items;
    }
    const refused = new Set<MediaItem>();
    for (const [origin, group] of origins) {
      let granted = false;
      try {
        granted =
          (await browser.permissions.containsHosts([origin])) ||
          (await browser.permissions.requestHosts([origin]));
      } catch (cause) {
        // A request outside a user gesture throws on some engines; that is a "no",
        // not a crash, and the user is told which host is missing.
        emitError('download-stream-host-request-failed', cause);
        granted = false;
      }
      if (!granted) {
        for (const item of group) {
          refused.add(item);
        }
        publishError(
          new PermissionDeniedError('Access to the media host was not granted', {
            code: 'download-stream-host-denied',
            messageKey: 'error.permission.host',
            context: { origin },
          }).toAppError(),
        );
      }
    }
    return items.filter((item) => !refused.has(item));
  };

  const enqueueItems = async (itemIds: readonly string[]): Promise<void> => {
    await ensureReady();
    if (!(await hasDownloadPermission())) {
      publishError(
        new PermissionDeniedError('The "downloads" permission is not granted', {
          code: 'download-permission-denied',
          messageKey: 'error.permission.downloads',
          context: { permission: DOWNLOADS_PERMISSION },
        }).toAppError(),
      );
      return;
    }
    const items = resolver.resolve(itemIds);
    if (items.length < itemIds.length) {
      publishError(
        new DownloadValidationError('Some requested media items are no longer available', {
          code: 'download-unknown-items',
          messageKey: 'error.download.validation',
          context: { requested: itemIds.length, resolved: items.length },
        }).toAppError(),
      );
    }
    if (items.length === 0) {
      return;
    }
    // Stream downloads read from the media host, so they need that host granted. The
    // popup asks on the click, but this funnel also serves the context menu (§4.13),
    // where nothing has asked yet — and without the grant the fetches would fail with
    // an opaque network error. Ask here too, and if the answer is no, say so plainly
    // instead of queueing work that cannot succeed (§13.7, §20.5).
    const downloadable = await withStreamHostAccess(items);
    if (downloadable.length === 0) {
      return;
    }
    // Validation, queueing, scheduling, retry and history all happen inside the
    // existing manager; the runtime only supplies the resolved items (§10.1).
    await manager.enqueue(downloadable);
  };

  const forwardManagerEvents = (): void => {
    unsubscribes.push(
      manager.on('job:queued', (task) => {
        state.recordEnqueued(1);
        emitTask('download:queued', task);
      }),
      manager.on('job:preparing', (task) => {
        state.clearRetry(task.id);
        emitTask('download:preparing', task);
      }),
      manager.on('job:started', (task) => {
        state.recordStarted();
        emitTask('download:started', task);
      }),
      manager.on('progress', (task) => {
        emitTask('download:progress', task);
      }),
      manager.on('job:completed', (task) => {
        state.recordCompleted();
        state.clearRetry(task.id);
        emitTask('download:completed', task);
      }),
      manager.on('job:failed', (task) => {
        state.recordFailed();
        state.clearRetry(task.id);
        emitTask('download:failed', task);
      }),
      manager.on('job:cancelled', (task) => {
        state.recordCanceled();
        state.clearRetry(task.id);
        emitTask('download:cancelled', task);
      }),
      manager.on('retry:scheduled', (scheduled) => {
        state.recordRetry({
          taskId: scheduled.task.id,
          attempt: scheduled.attempt,
          delayMs: scheduled.delayMs,
          scheduledAt: clock(),
        });
        emitter.emit('retry:scheduled', scheduled);
        broadcast({
          event: 'retry:scheduled',
          task: toProgressSnapshot(scheduled.task),
          retry: {
            taskId: scheduled.task.id,
            attempt: scheduled.attempt,
            delayMs: scheduled.delayMs,
          },
        });
      }),
      manager.on('queue:paused', () => {
        state.setScheduling(false);
        emitter.emit('queue:paused');
        broadcast({ event: 'queue:paused' });
      }),
      manager.on('queue:resumed', () => {
        state.setScheduling(true);
        emitter.emit('queue:resumed');
        broadcast({ event: 'queue:resumed' });
      }),
      manager.on('queue:completed', (summary) => {
        emitter.emit('queue:completed', summary);
        broadcast({ event: 'queue:completed', summary });
      }),
      manager.on('error', (error) => {
        publishError(error);
      }),
    );
  };

  const registerMessageHandlers = (): void => {
    const bus = browser.messaging;
    const command = async (
      request: unknown,
      action: (taskId: string) => Promise<void>,
    ): Promise<void> => {
      const taskId = extractTaskId(request);
      if (taskId === undefined) {
        return;
      }
      await run(async () => {
        await ensureReady();
        await action(taskId);
      });
    };

    unsubscribes.push(
      // Surface → background: enqueue detected media by identity key (§8.6). The
      // payload is untrusted (§13.8): a malformed request is rejected outright.
      bus.on('download/enqueue', async (request) => {
        const itemIds = extractItemIds(request);
        if (itemIds === undefined || itemIds.length === 0) {
          return;
        }
        await run(() => enqueueItems(itemIds));
      }),
      bus.on('download/cancel', (request) => command(request, (id) => manager.cancel(id))),
      bus.on('download/retry', (request) => command(request, (id) => manager.retry(id))),
      bus.on('download/pause', (request) => command(request, (id) => manager.pause(id))),
      bus.on('download/resume', (request) => command(request, (id) => manager.resume(id))),
      bus.on('download/remove', (request) => command(request, (id) => manager.remove(id))),
      bus.on('download/clear', () =>
        run(async () => {
          await ensureReady();
          await manager.clearQueue();
        }),
      ),
      bus.on('download/query', () =>
        run(async () => {
          await ensureReady();
          return manager.getQueue();
        }),
      ),
      bus.on('download/progress', () =>
        run(async () => {
          await ensureReady();
          const tasks = await manager.getQueue();
          return tasks.filter((task) => IN_FLIGHT_STATES.has(task.state)).map(toProgressSnapshot);
        }),
      ),
      bus.on('download/stats', () =>
        run(async () => {
          await ensureReady();
          return manager.stats();
        }),
      ),
    );
  };

  const registerLifecycleListeners = (): void => {
    unsubscribes.push(
      // Install/update: initialize the durable store and reconstruct the queue,
      // never dropping user data (§8.8, §8.14).
      browser.runtime.onInstalled(() => {
        void ensureReady();
      }),
      // Browser startup: reconstruct the queue and resume interrupted jobs (§8.9).
      browser.runtime.onStartup(() => {
        void ensureReady();
      }),
    );
  };

  return {
    start(): void {
      if (started) {
        return;
      }
      started = true;
      forwardManagerEvents();
      // Hold scheduling until the durable queue is reconstructed, so a cold start
      // can never transfer against a half-loaded queue (§8.9). `ensureReady`
      // releases it. Nothing can enqueue before the handlers below exist.
      manager.pauseQueue();
      registerMessageHandlers();
      registerLifecycleListeners();
    },

    enqueue(itemIds: readonly string[]): Promise<void> {
      const ids = [...new Set(itemIds.filter((id) => id !== ''))];
      return ids.length === 0 ? Promise.resolve() : run(() => enqueueItems(ids));
    },

    ready(): Promise<void> {
      return ensureReady();
    },

    applySettings,

    on<K extends keyof DownloadRuntimeEventMap>(
      event: K,
      listener: (...args: DownloadRuntimeEventMap[K]) => void,
    ): Unsubscribe {
      return emitter.on(event, listener);
    },

    state,

    snapshot(): DownloadRuntimeSnapshot {
      return { stats: manager.stats(), health: state.health(), retries: state.retries() };
    },

    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
      unsubscribes.length = 0;
      emitter.clear();
      // Releases the manager's native listener, retry timers and progress samples.
      // Jobs are deliberately NOT cancelled: suspension must leave the durable queue
      // intact so the next wake can reconstruct and resume it (§8.9, §15.8).
      await manager.dispose();
    },
  };
}
