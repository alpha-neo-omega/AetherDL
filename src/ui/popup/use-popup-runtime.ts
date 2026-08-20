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
 * Public API: PopupStatus, QualityChooser, PopupRuntimeData, PopupRuntimeActions,
 *          usePopupRuntime.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { AppError } from '@shared/result';
import type {
  DownloadEventBroadcast,
  DownloadProgressSnapshot,
  DownloadTask,
  MediaItem,
  StreamRenditionSnapshot,
} from '@shared/types';
import { toAppError } from './errors';
import type { PopupRuntimeClient } from './runtime-client';

export type PopupStatus = 'loading' | 'ready' | 'error';

/**
 * The open quality chooser (§10.6). `loading` while the manifest is being read — one
 * small GET, but a network round trip all the same, so the surface says so rather
 * than looking stuck.
 */
export interface QualityChooser {
  readonly item: MediaItem;
  readonly status: 'loading' | 'ready';
  readonly renditions: readonly StreamRenditionSnapshot[];
}

export interface PopupRuntimeData {
  readonly status: PopupStatus;
  readonly items: readonly MediaItem[];
  readonly tasks: readonly DownloadTask[];
  /** A failure that left the popup with nothing to show (§11.5 error state). */
  readonly error: AppError | undefined;
  /** A recoverable failure shown alongside results (§20.5). */
  readonly notice: AppError | undefined;
  /** The stream whose qualities the user is choosing from, if any (§10.6). */
  readonly chooser: QualityChooser | undefined;
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
  /** Read what this stream offers and open the chooser (§10.6). */
  chooseQuality(item: MediaItem): void;
  /** Queue one item at the rendition the user picked. */
  downloadRendition(itemId: string, renditionId: string): void;
  closeChooser(): void;
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
  | { readonly type: 'dismiss' }
  | { readonly type: 'chooser-open'; readonly item: MediaItem }
  | { readonly type: 'chooser-ready'; readonly renditions: readonly StreamRenditionSnapshot[] }
  | { readonly type: 'chooser-close' };

const INITIAL: PopupRuntimeData = {
  status: 'loading',
  items: [],
  tasks: [],
  error: undefined,
  notice: undefined,
  chooser: undefined,
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
        chooser: state.chooser,
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
    case 'chooser-open':
      return { ...state, chooser: { item: action.item, status: 'loading', renditions: [] } };
    case 'chooser-ready':
      // Only fills the chooser that is still open: the user may have closed it while
      // the manifest was being read, and re-opening it under them would be wrong.
      return state.chooser === undefined
        ? state
        : {
            ...state,
            chooser: { ...state.chooser, status: 'ready', renditions: action.renditions },
          };
    case 'chooser-close':
      return state.chooser === undefined ? state : { ...state, chooser: undefined };
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
  // The latest detected items, readable from the action callbacks without making
  // `actions` depend on them (which would rebuild every handler on each detection).
  const itemsRef = useRef<readonly MediaItem[]>([]);
  itemsRef.current = state.items;

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
        if (itemIds.length === 0) {
          return;
        }
        const wanted = new Set(itemIds);
        const urls = itemsRef.current.filter((item) => wanted.has(item.id)).map((item) => item.url);
        // First call in the handler, so the user gesture is still live: a stream is
        // read by the extension itself and needs access to its host, which is asked
        // for here and nowhere else (§13.7, §4.15). Progressive files need nothing.
        run(
          client.requestStreamAccess(urls).then((granted) => {
            if (!granted) {
              throw {
                category: 'permission',
                code: 'popup-stream-host-denied',
                messageKey: 'error.permission.host',
                retryable: true,
              } satisfies AppError;
            }
            return client.enqueue(itemIds);
          }),
        );
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
      chooseQuality: (item) => {
        dispatch({ type: 'chooser-open', item });
        // Host access first, from the live gesture, exactly as a download does: the
        // manifest read needs the same grant, so the user is asked once (§13.7).
        void client
          .requestStreamAccess([item.url])
          .then((granted) => {
            if (!granted) {
              throw {
                category: 'permission',
                code: 'popup-stream-host-denied',
                messageKey: 'error.permission.host',
                retryable: true,
              } satisfies AppError;
            }
            return client.listStreamQualities(item.url);
          })
          .then(
            (renditions) => {
              dispatch({ type: 'chooser-ready', renditions });
            },
            (cause: unknown) => {
              // A stream whose qualities cannot be read is still downloadable at the
              // preferred quality, so the chooser closes and says why rather than
              // sitting open with nothing in it.
              dispatch({ type: 'chooser-close' });
              dispatch({ type: 'notice', error: toAppError(cause) });
            },
          );
      },
      downloadRendition: (itemId, renditionId) => {
        dispatch({ type: 'chooser-close' });
        // Access was granted when the chooser opened; this call does not re-ask.
        run(client.enqueue([itemId], renditionId));
      },
      closeChooser: () => {
        dispatch({ type: 'chooser-close' });
      },
    };
  }, [client, refreshQueue]);

  return { ...state, actions };
}
