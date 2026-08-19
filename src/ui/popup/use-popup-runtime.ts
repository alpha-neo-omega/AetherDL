/**
 * Module: ui/popup (runtime data hook)
 * Purpose: Bind the popup to the background runtime: load the active tab's detected
 *          media and the download queue, subscribe to the runtime's pushed events,
 *          and expose the approved intents (PROJECT_BIBLE.md §8.5, §8.6, §12.4).
 * Restrictions: UI layer — a VIEW over runtime state. It runs no detection and no
 *          download logic, owns no domain state machine, and never mutates domain
 *          state directly: every change is an intent sent through the port and every
 *          update comes back from the runtime (§8.7, §13.2). Progress arrives as
 *          pushed snapshots rather than polling (§12.4, §12.4 performance). Both
 *          subscriptions are released on unmount (§12.7).
 * Public API: PopupStatus, PopupRuntimeData, PopupRuntimeActions, usePopupRuntime.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { AppError } from '@shared/result';
import type {
  DownloadEventBroadcast,
  DownloadProgressSnapshot,
  DownloadTask,
  MediaItem,
} from '@shared/types';
import { toAppError } from './errors';
import type { PopupRuntimeClient } from './runtime-client';

export type PopupStatus = 'loading' | 'ready' | 'error';

export interface PopupRuntimeData {
  readonly status: PopupStatus;
  readonly items: readonly MediaItem[];
  readonly tasks: readonly DownloadTask[];
  /** A failure that left the popup with nothing to show (§11.5 error state). */
  readonly error: AppError | undefined;
  /** A recoverable failure shown alongside results (§20.5). */
  readonly notice: AppError | undefined;
}

export interface PopupRuntimeActions {
  reload(): void;
  download(itemIds: readonly string[]): void;
  cancel(taskId: string): void;
  retry(taskId: string): void;
  pause(taskId: string): void;
  resume(taskId: string): void;
  remove(taskId: string): void;
  clearQueue(): void;
  copyLink(item: MediaItem): void;
  dismissNotice(): void;
}

type Action =
  | { readonly type: 'loading' }
  | {
      readonly type: 'loaded';
      readonly items: readonly MediaItem[];
      readonly tasks: readonly DownloadTask[];
    }
  | { readonly type: 'items'; readonly items: readonly MediaItem[] }
  | { readonly type: 'tasks'; readonly tasks: readonly DownloadTask[] }
  | { readonly type: 'progress'; readonly snapshot: DownloadProgressSnapshot }
  | { readonly type: 'failed'; readonly error: AppError }
  | { readonly type: 'notice'; readonly error: AppError }
  | { readonly type: 'dismiss' };

const INITIAL: PopupRuntimeData = {
  status: 'loading',
  items: [],
  tasks: [],
  error: undefined,
  notice: undefined,
};

/**
 * Apply a pushed progress snapshot to the job it names. This renders state the
 * runtime already decided; it does not advance a state machine of its own (§13.2).
 */
function applyProgress(
  tasks: readonly DownloadTask[],
  snapshot: DownloadProgressSnapshot,
): readonly DownloadTask[] {
  let changed = false;
  const next = tasks.map((task) => {
    if (task.id !== snapshot.taskId) {
      return task;
    }
    changed = true;
    return {
      ...task,
      state: snapshot.state,
      ...(snapshot.bytesReceived !== undefined && { bytesReceived: snapshot.bytesReceived }),
      ...(snapshot.bytesTotal !== undefined && { bytesTotal: snapshot.bytesTotal }),
      ...(snapshot.progress !== undefined && { progress: snapshot.progress }),
    };
  });
  return changed ? next : tasks;
}

function reducer(state: PopupRuntimeData, action: Action): PopupRuntimeData {
  switch (action.type) {
    case 'loading':
      return { ...state, status: 'loading', error: undefined };
    case 'loaded':
      return {
        status: 'ready',
        items: action.items,
        tasks: action.tasks,
        error: undefined,
        notice: state.notice,
      };
    case 'items':
      return { ...state, items: action.items };
    case 'tasks':
      return { ...state, tasks: action.tasks };
    case 'progress':
      return { ...state, tasks: applyProgress(state.tasks, action.snapshot) };
    case 'failed':
      return { ...state, status: 'error', error: action.error };
    case 'notice':
      return { ...state, notice: action.error };
    case 'dismiss':
      return state.notice === undefined ? state : { ...state, notice: undefined };
    default:
      return state;
  }
}

export function usePopupRuntime(
  client: PopupRuntimeClient,
): PopupRuntimeData & { readonly actions: PopupRuntimeActions } {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const [reloadToken, setReloadToken] = useState(0);
  const tabIdRef = useRef<number | undefined>(undefined);

  const refreshQueue = useCallback((): void => {
    void client.queryQueue().then(
      (tasks) => {
        dispatch({ type: 'tasks', tasks });
      },
      (cause: unknown) => {
        dispatch({ type: 'notice', error: toAppError(cause) });
      },
    );
  }, [client]);

  // Initial load, and every explicit retry. Detection results are per-tab (§4.1).
  useEffect(() => {
    let cancelled = false;
    dispatch({ type: 'loading' });
    void (async (): Promise<void> => {
      try {
        const tabId = await client.getActiveTabId();
        const items = tabId === undefined ? [] : await client.queryDetection(tabId);
        const tasks = await client.queryQueue();
        if (cancelled) {
          return;
        }
        tabIdRef.current = tabId;
        dispatch({ type: 'loaded', items, tasks });
        if (tabId !== undefined) {
          // Opening the popup is the user gesture that lets the background observe
          // the page (§13.7). What is already known is shown immediately; anything
          // the fresh observation adds arrives on the detection stream (§4.1).
          void client.refreshDetection(tabId).catch(() => undefined);
        }
      } catch (cause) {
        if (!cancelled) {
          dispatch({ type: 'failed', error: toAppError(cause) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, reloadToken]);

  // Pushed runtime updates. Progress patches in place; anything that can change
  // queue membership re-reads the queue, which stays the source of truth (§4.4).
  useEffect(() => {
    const onDownload = (event: DownloadEventBroadcast): void => {
      if (event.event === 'download:progress' && event.task !== undefined) {
        dispatch({ type: 'progress', snapshot: event.task });
        return;
      }
      if (event.event === 'error' && event.error !== undefined) {
        dispatch({ type: 'notice', error: event.error });
      }
      refreshQueue();
    };
    const offDownload = client.onDownloadEvent(onDownload);
    const offDetection = client.onDetectionFinished((tabId: number) => {
      if (tabIdRef.current !== undefined && tabId !== tabIdRef.current) {
        return;
      }
      void client.queryDetection(tabId).then(
        (items) => {
          dispatch({ type: 'items', items });
        },
        (cause: unknown) => {
          dispatch({ type: 'notice', error: toAppError(cause) });
        },
      );
    });
    return () => {
      offDownload();
      offDetection();
    };
  }, [client, refreshQueue]);

  const actions = useMemo<PopupRuntimeActions>(() => {
    const run = (operation: Promise<void>): void => {
      void operation.then(
        () => {
          refreshQueue();
        },
        (cause: unknown) => {
          dispatch({ type: 'notice', error: toAppError(cause) });
        },
      );
    };
    return {
      reload: () => {
        setReloadToken((token) => token + 1);
      },
      download: (itemIds) => {
        if (itemIds.length > 0) {
          run(client.enqueue(itemIds));
        }
      },
      cancel: (taskId) => {
        run(client.cancel(taskId));
      },
      retry: (taskId) => {
        run(client.retry(taskId));
      },
      pause: (taskId) => {
        run(client.pause(taskId));
      },
      resume: (taskId) => {
        run(client.resume(taskId));
      },
      remove: (taskId) => {
        run(client.remove(taskId));
      },
      clearQueue: () => {
        run(client.clearQueue());
      },
      copyLink: (item) => {
        void client.copyLink(item.url).catch((cause: unknown) => {
          dispatch({ type: 'notice', error: toAppError(cause) });
        });
      },
      dismissNotice: () => {
        dispatch({ type: 'dismiss' });
      },
    };
  }, [client, refreshQueue]);

  return { ...state, actions };
}
