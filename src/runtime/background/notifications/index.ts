/**
 * Module: runtime/background/notifications
 * Purpose: Notification orchestration for user-initiated outcomes
 *          (PROJECT_BIBLE.md §4.10): a download completed, a download failed after
 *          its retries, or the queue finished.
 * Restrictions: Thin surface — delegates to platform/notifications and forwards the
 *          download runtime's existing events; it creates no event system and no
 *          download logic (§8.1). DOUBLY GATED: silent unless the user enabled
 *          notifications AND the optional `notifications` permission is granted, and
 *          it never requests that permission itself (§4.10, §13.1, §13.3). Never
 *          used for marketing, tips, nags or engagement (§2.8, §3). Bulk work is
 *          coalesced into one summary rather than a toast per job (§4.10).
 * Public API: NotificationRuntime, NotificationRuntimeDeps, NotificationCopy,
 *          createNotificationRuntime.
 */
import type { Browser } from '@platform/browser';
import type { AppError } from '@shared/result';
import { PlatformError, RuntimeError } from '@shared/result/errors';
import type { DownloadTask, Settings } from '@shared/types';
import type { Unsubscribe } from '@shared/utils';
import type { BackgroundDownloadRuntime } from '@runtime/background/downloads';

const PERMISSION = 'notifications';

/** Localized copy, supplied by the composition root (§19.1). */
export interface NotificationCopy {
  completed(task: DownloadTask): { readonly title: string; readonly message: string };
  failed(task: DownloadTask): { readonly title: string; readonly message: string };
  queueCompleted(summary: {
    readonly completed: number;
    readonly failed: number;
    readonly canceled: number;
  }): { readonly title: string; readonly message: string };
}

export interface NotificationRuntime {
  start(): void;
  dispose(): void;
}

export interface NotificationRuntimeDeps {
  readonly browser: Browser;
  readonly downloads: BackgroundDownloadRuntime;
  readonly getSettings: () => Promise<Settings>;
  readonly copy: NotificationCopy;
  readonly onError: (error: AppError) => void;
  /** Icon shown on a notification; resolved to a packaged asset (§13.2). */
  readonly iconUrl?: string;
}

function toAppError(cause: unknown): AppError {
  return cause instanceof PlatformError
    ? cause.toAppError()
    : new RuntimeError('Notification error', {
        code: 'notification-failed',
        messageKey: 'error.runtime.notifications',
        cause,
      }).toAppError();
}

export function createNotificationRuntime(deps: NotificationRuntimeDeps): NotificationRuntime {
  const { browser, downloads } = deps;
  const unsubscribes: Unsubscribe[] = [];
  let started = false;
  let disposed = false;

  /**
   * Both gates, checked per notification so revoking the permission or turning the
   * setting off takes effect immediately (§4.9 applied live, §13.3).
   */
  const isAllowed = async (): Promise<boolean> => {
    if (browser.notifications === undefined) {
      return false;
    }
    try {
      if (!(await deps.getSettings()).notifications) {
        return false;
      }
      return await browser.permissions.contains([PERMISSION]);
    } catch (cause) {
      deps.onError(toAppError(cause));
      return false;
    }
  };

  const show = async (id: string, title: string, message: string): Promise<void> => {
    if (disposed || !(await isAllowed())) {
      return;
    }
    try {
      await browser.notifications?.create(id, {
        title,
        message,
        ...(deps.iconUrl !== undefined && { iconUrl: deps.iconUrl }),
      });
    } catch (cause) {
      deps.onError(toAppError(cause));
    }
  };

  /**
   * A bulk run gets one summary, not one toast per job (§4.10): while more than a
   * single job is still in flight, per-job outcomes stay quiet and `queue:completed`
   * reports the batch.
   */
  const isBulk = (): boolean => {
    const { stats } = downloads.snapshot();
    return stats.queued + stats.preparing + stats.active + stats.retrying + stats.paused > 1;
  };

  const announce = (task: DownloadTask, kind: 'completed' | 'failed'): void => {
    if (isBulk()) {
      return;
    }
    const copy = kind === 'completed' ? deps.copy.completed(task) : deps.copy.failed(task);
    void show(`aetherdl:${kind}:${task.id}`, copy.title, copy.message);
  };

  return {
    start(): void {
      if (started) {
        return;
      }
      started = true;
      unsubscribes.push(
        downloads.on('download:completed', (task) => {
          announce(task, 'completed');
        }),
        // Only a terminal failure is announced; a scheduled retry is not an outcome
        // the user needs to be interrupted for (§4.5, §2.8).
        downloads.on('download:failed', (task) => {
          announce(task, 'failed');
        }),
        downloads.on('queue:completed', (summary) => {
          const copy = deps.copy.queueCompleted(summary);
          void show('aetherdl:queue-completed', copy.title, copy.message);
        }),
      );
    },

    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
      unsubscribes.length = 0;
    },
  };
}
