/**
 * Module: platform/downloads
 * Purpose: Thin wrapper contract over the native Downloads API (PROJECT_BIBLE.md
 *          §10.8). Platform access ONLY — no queue, retry, filename, or manager
 *          logic (that is Phase 5). Implementation in ./service.
 * Restrictions: Platform layer — adapts only (§8.2, §8.4).
 * Dependencies: shared/types (TaskState), shared/utils (Unsubscribe).
 * Public API: ConflictAction, NativeDownloadOptions, DownloadChange,
 *          DownloadProgress, DownloadsAdapter.
 */
import type { TaskState } from '@shared/types';
import type { Unsubscribe } from '@shared/utils';

export type ConflictAction = 'uniquify' | 'overwrite' | 'prompt';

export interface NativeDownloadOptions {
  readonly url: string;
  readonly filename: string;
  readonly conflictAction: ConflictAction;
  readonly saveAs: boolean;
}

/** A state-change notification for a native download. */
export interface DownloadChange {
  readonly id: number;
  readonly state: TaskState | undefined;
}

/** A point-in-time progress snapshot fetched on demand. */
export interface DownloadProgress {
  readonly id: number;
  readonly state: TaskState | undefined;
  readonly bytesReceived: number | undefined;
  readonly bytesTotal: number | undefined;
}

export interface DownloadsAdapter {
  /** Start a native download; resolves to the browser download id. */
  start(options: NativeDownloadOptions): Promise<number>;
  /** Cancel an in-flight native download. */
  cancel(downloadId: number): Promise<void>;
  /** Fetch a current progress snapshot, or `undefined` if the id is unknown. */
  getProgress(downloadId: number): Promise<DownloadProgress | undefined>;
  /** Subscribe to state-change notifications (start/complete/fail transitions). */
  onChanged(listener: (change: DownloadChange) => void): Unsubscribe;
}
