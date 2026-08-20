/**
 * Module: core/storage (durable queue repository)
 * Purpose: The durable {@link QueueRepository} the download queue persists through
 *          (PROJECT_BIBLE.md §8.14, §10.2). It stores only the queue metadata a cold
 *          start needs to reconstruct a job, over the injected structured object
 *          store; hydration/recovery semantics stay entirely in the queue (§8.9).
 * Restrictions: Domain layer — persistence via the platform object-store adapter
 *          only; no browser APIs, no IndexedDB details, local-only (§14). NEVER
 *          persists transient runtime state: the native download handle, in-flight
 *          byte counters, progress ratios, retry timers, and error diagnostics are
 *          all dropped. Never throws: a storage failure is reported and the queue
 *          keeps working in memory so one bad write cannot take the background down
 *          (§20.7).
 * Public API: QUEUE_DATABASE_NAME, QUEUE_STORE_NAME, PersistedDownloadTask,
 *          QueueRepositoryDeps, createQueueRepository.
 */
import type { ObjectStore } from '@platform/storage';
import type { AppError } from '@shared/result';
import { StorageError } from '@shared/result/errors';
import type { DownloadTask, MediaItem, TaskState } from '@shared/types';
import type { QueueRepository } from '@core/storage';

/** Database and object store holding the persisted download queue (§8.14). */
/** The queue's own database; see the note on HISTORY_DATABASE_NAME (§8.14). */
export const QUEUE_DATABASE_NAME = 'aetherdl-queue';
export const QUEUE_STORE_NAME = 'download-queue';

/**
 * The persisted projection of a {@link DownloadTask}. Explicit by construction: a
 * field only survives a restart if it is listed here, so transient state cannot leak
 * into storage by accident.
 */
export interface PersistedDownloadTask {
  readonly id: string;
  readonly item: MediaItem;
  readonly state: TaskState;
  readonly filename: string;
  readonly attempt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly originalFilename?: string;
  readonly priority?: number;
  /** Total size when known; job metadata, not an in-flight counter. */
  readonly bytesTotal?: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  /** Error without `cause`/`context` — those are local dev diagnostics (§20.5). */
  readonly error?: AppError;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface QueueRepositoryDeps {
  /**
   * The structured store. Typed `unknown` on purpose: persisted records are
   * untrusted until validated on load (§13.8).
   */
  readonly store: ObjectStore<unknown>;
  /** Receives every storage failure; the repository itself never throws (§20.7). */
  readonly onError: (error: AppError) => void;
}

/** Exhaustive by type: a new {@link TaskState} fails to compile until listed. */
const TASK_STATES: Readonly<Record<TaskState, true>> = {
  queued: true,
  preparing: true,
  active: true,
  paused: true,
  retrying: true,
  canceling: true,
  canceled: true,
  completed: true,
  failed: true,
  removed: true,
};

const ERROR_CATEGORIES: ReadonlySet<string> = new Set([
  'network',
  'http',
  'drm',
  'validation',
  'storage',
  'permission',
  'capability',
  'internal',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTaskState(value: unknown): value is TaskState {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TASK_STATES, value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

/** Validate the media item a job cannot be reconstructed without (§9.6). */
function isMediaItem(value: unknown): value is MediaItem {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value['id'] === 'string' &&
    typeof value['kind'] === 'string' &&
    typeof value['status'] === 'string' &&
    typeof value['title'] === 'string' &&
    typeof value['url'] === 'string' &&
    typeof value['originHost'] === 'string' &&
    typeof value['detectedBy'] === 'string' &&
    isFiniteNumber(value['score']) &&
    isFiniteNumber(value['discoveredAt'])
  );
}

function isAppError(value: unknown): value is AppError {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value['category'] === 'string' &&
    ERROR_CATEGORIES.has(value['category']) &&
    typeof value['code'] === 'string' &&
    typeof value['messageKey'] === 'string' &&
    typeof value['retryable'] === 'boolean'
  );
}

/** Guard a stored record before it re-enters the queue (§13.8). */
function isPersistedTask(value: unknown): value is PersistedDownloadTask {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value['id'] === 'string' &&
    value['id'] !== '' &&
    isTaskState(value['state']) &&
    typeof value['filename'] === 'string' &&
    isFiniteNumber(value['attempt']) &&
    isFiniteNumber(value['createdAt']) &&
    isFiniteNumber(value['updatedAt']) &&
    optionalString(value['originalFilename']) &&
    optionalNumber(value['priority']) &&
    optionalNumber(value['bytesTotal']) &&
    optionalNumber(value['startedAt']) &&
    optionalNumber(value['completedAt']) &&
    (value['error'] === undefined || isAppError(value['error'])) &&
    (value['metadata'] === undefined || isRecord(value['metadata'])) &&
    isMediaItem(value['item'])
  );
}

/** Drop `cause`/`context`: developer diagnostics never reach durable storage (§20.5). */
function toPersistedError(error: AppError): AppError {
  return {
    category: error.category,
    code: error.code,
    messageKey: error.messageKey,
    retryable: error.retryable,
  };
}

/**
 * Project a live job onto its persisted form. `nativeDownloadId`, `bytesReceived`
 * and `progress` describe a transfer that cannot outlive the process and are
 * deliberately absent (§8.9).
 */
function toPersisted(task: DownloadTask): PersistedDownloadTask {
  return {
    id: task.id,
    item: task.item,
    state: task.state,
    filename: task.filename,
    attempt: task.attempt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.originalFilename !== undefined && { originalFilename: task.originalFilename }),
    ...(task.priority !== undefined && { priority: task.priority }),
    ...(task.bytesTotal !== undefined && { bytesTotal: task.bytesTotal }),
    ...(task.startedAt !== undefined && { startedAt: task.startedAt }),
    ...(task.completedAt !== undefined && { completedAt: task.completedAt }),
    ...(task.error !== undefined && { error: toPersistedError(task.error) }),
    ...(task.metadata !== undefined && { metadata: task.metadata }),
  };
}

/** Rebuild a queue job from its persisted form; the queue applies recovery (§8.9). */
function toTask(record: PersistedDownloadTask): DownloadTask {
  return {
    id: record.id,
    item: record.item,
    state: record.state,
    filename: record.filename,
    attempt: record.attempt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.originalFilename !== undefined && { originalFilename: record.originalFilename }),
    ...(record.priority !== undefined && { priority: record.priority }),
    ...(record.bytesTotal !== undefined && { bytesTotal: record.bytesTotal }),
    ...(record.startedAt !== undefined && { startedAt: record.startedAt }),
    ...(record.completedAt !== undefined && { completedAt: record.completedAt }),
    ...(record.error !== undefined && { error: record.error }),
    ...(record.metadata !== undefined && { metadata: record.metadata }),
  };
}

export function createQueueRepository(deps: QueueRepositoryDeps): QueueRepository {
  const { store, onError } = deps;
  /**
   * What is currently in the store, id → the exact record last written for it. The
   * value is what makes a save a DIFF: `save` is called on every queue mutation, and
   * a progress patch on one job used to rewrite every record in the queue — a hundred
   * writes to change one number (§12.1, §8.14).
   */
  let known: Map<string, string> | undefined;
  /** Set when a read failed: further writes are skipped so unreadable durable data
   *  is never overwritten by a queue that could not be reconstructed (§20.7). */
  let readFailed = false;

  const report = (operation: string, cause: unknown): void => {
    onError(
      new StorageError(`Download queue ${operation} failed`, {
        code: `queue-${operation}-failed`,
        messageKey: 'error.storage.operation',
        cause,
      }).toAppError(),
    );
  };

  return {
    async load(): Promise<readonly DownloadTask[]> {
      try {
        const raw = await store.getAll();
        const records = raw.filter(isPersistedTask);
        if (records.length !== raw.length) {
          report(
            'load-validate',
            new Error(`Dropped ${raw.length - records.length} bad record(s)`),
          );
        }
        known = new Map(records.map((record) => [record.id, JSON.stringify(record)]));
        readFailed = false;
        return records.map(toTask);
      } catch (cause) {
        readFailed = true;
        report('load', cause);
        return [];
      }
    },

    async save(tasks: readonly DownloadTask[]): Promise<void> {
      if (readFailed) {
        return;
      }
      try {
        if (known === undefined) {
          const existing = await store.getAll();
          known = new Map(
            existing
              .filter(isPersistedTask)
              .map((record) => [record.id, JSON.stringify(record)] as const),
          );
        }
        const next = new Map(
          tasks.map((task) => {
            const record = toPersisted(task);
            return [task.id, { record, serialized: JSON.stringify(record) }] as const;
          }),
        );
        // Delete before writing: a crash mid-save can then leave stale-but-valid
        // records at worst, never resurrect a job the user removed (§20.7).
        for (const id of known.keys()) {
          if (!next.has(id)) {
            await store.delete(id);
          }
        }
        // Write only what actually changed. An unchanged record is already durable, so
        // rewriting it buys nothing and costs a transaction.
        for (const [id, entry] of next) {
          if (known.get(id) !== entry.serialized) {
            await store.put(id, entry.record);
          }
        }
        known = new Map([...next].map(([id, entry]) => [id, entry.serialized]));
      } catch (cause) {
        // The in-memory queue stays authoritative for this session; the next save
        // re-reconciles the store from scratch.
        known = undefined;
        report('save', cause);
      }
    },
  };
}
