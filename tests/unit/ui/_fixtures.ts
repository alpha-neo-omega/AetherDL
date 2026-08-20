/**
 * Test fixtures for the UI layer: media/task builders, ready-made component label
 * bundles, and a controllable fake of the popup's runtime client port. The fake sits
 * exactly at the messaging boundary — the popup is exercised through the same
 * contract the real adapter implements, never through React internals. Not a test file.
 */
import { act } from 'react';
import type { MediaCardLabels } from '@ui/components';
import { createTranslator, type PopupRuntimeClient, type QueuePanelLabels } from '@ui/popup';
import type {
  DownloadEventBroadcast,
  DownloadTask,
  MediaItem,
  Settings,
  TaskState,
} from '@shared/types';
import { DEFAULT_SETTINGS } from '@core/settings';

const t = createTranslator();

export function mediaItem(props: Partial<MediaItem> & { readonly id: string }): MediaItem {
  return {
    kind: 'video',
    status: 'supported',
    title: `Title ${props.id}`,
    url: `https://example.com/${props.id}.mp4`,
    originHost: 'example.com',
    detectedBy: 'html5-video',
    score: 1,
    discoveredAt: 0,
    ...props,
  };
}

export function downloadTask(
  props: Partial<DownloadTask> & { readonly id: string; readonly item: MediaItem },
): DownloadTask {
  return {
    state: 'queued',
    filename: `${props.item.title}.mp4`,
    attempt: 0,
    createdAt: 1,
    updatedAt: 1,
    ...props,
  };
}

function taskStates(): Readonly<Record<TaskState, string>> {
  return {
    queued: t('task.queued'),
    preparing: t('task.preparing'),
    active: t('task.active'),
    paused: t('task.paused'),
    retrying: t('task.retrying'),
    canceling: t('task.canceling'),
    canceled: t('task.canceled'),
    completed: t('task.completed'),
    failed: t('task.failed'),
    removed: t('task.removed'),
  };
}

export function cardLabels(): MediaCardLabels {
  return {
    download: t('card.download'),
    copyLink: t('card.copyLink'),
    select: t('card.select'),
    unsupported: t('card.unsupported'),
    estimated: t('card.estimated'),
    alreadyQueued: t('card.alreadyQueued'),
    progressLabel: t('card.progress'),
    fields: {
      type: t('card.field.type'),
      quality: t('card.field.quality'),
      resolution: t('card.field.resolution'),
      duration: t('card.field.duration'),
      size: t('card.field.size'),
      host: t('card.field.host'),
      filename: t('card.field.filename'),
      codec: t('card.field.codec'),
      delivery: t('card.field.delivery'),
    },
    taskState: taskStates(),
  };
}

export function queueLabels(): QueuePanelLabels {
  return {
    title: t('queue.title'),
    show: t('queue.show'),
    hide: t('queue.hide'),
    empty: t('queue.empty'),
    summary: t('queue.summary'),
    clear: t('queue.clear'),
    clearHint: t('queue.clearHint'),
    listLabel: t('queue.list.label'),
    cancel: t('queue.cancel'),
    retry: t('queue.retry'),
    pause: t('queue.pause'),
    resume: t('queue.resume'),
    remove: t('queue.remove'),
    progressLabel: t('card.progress'),
    taskState: taskStates(),
  };
}

export interface FakeRuntimeClient {
  readonly client: PopupRuntimeClient;
  /** Calls made, in order, as `"<method>:<argument>"`. */
  readonly calls: string[];
  /** Live subscriber counts; must return to zero when the popup unmounts. */
  readonly subscriptions: { downloads: number; detection: number };
  setTabId(tabId: number | undefined): void;
  setItems(items: readonly MediaItem[]): void;
  setTasks(tasks: readonly DownloadTask[]): void;
  /** Decide what a point-of-use host-permission request answers (§13.7). */
  setStreamAccess(granted: boolean): void;
  /** Make the next call of a method reject with `error`. */
  failNext(method: string, error: unknown): void;
  /** Push a runtime download event, as the background broadcasts it. */
  emitDownload(event: DownloadEventBroadcast): void;
  /** Announce fresh detection results for a tab. */
  emitDetection(tabId: number): void;
  /** Announce an applied settings catalogue, as the background broadcasts it. */
  emitSettings(settings: Settings): void;
}

export function createFakeRuntimeClient(): FakeRuntimeClient {
  const calls: string[] = [];
  const failures = new Map<string, unknown>();
  const downloadListeners = new Set<(event: DownloadEventBroadcast) => void>();
  const detectionListeners = new Set<(tabId: number) => void>();
  const subscriptions = { downloads: 0, detection: 0 };
  let tabId: number | undefined = 7;
  let items: readonly MediaItem[] = [];
  let tasks: readonly DownloadTask[] = [];
  let settings: Settings = DEFAULT_SETTINGS;
  let streamAccess = true;
  const settingsListeners = new Set<(next: Settings) => void>();

  const guard = <T>(method: string, argument: string, value: T): Promise<T> => {
    calls.push(argument === '' ? method : `${method}:${argument}`);
    if (failures.has(method)) {
      const error = failures.get(method);
      failures.delete(method);
      return Promise.reject(error);
    }
    return Promise.resolve(value);
  };

  return {
    calls,
    subscriptions,
    setTabId(next: number | undefined): void {
      tabId = next;
    },
    setItems(next: readonly MediaItem[]): void {
      items = next;
    },
    setTasks(next: readonly DownloadTask[]): void {
      tasks = next;
    },
    setStreamAccess(granted: boolean): void {
      streamAccess = granted;
    },
    failNext(method: string, error: unknown): void {
      failures.set(method, error);
    },
    emitDownload(event: DownloadEventBroadcast): void {
      act(() => {
        for (const listener of [...downloadListeners]) {
          listener(event);
        }
      });
    },
    emitDetection(id: number): void {
      act(() => {
        for (const listener of [...detectionListeners]) {
          listener(id);
        }
      });
    },
    emitSettings(next: Settings): void {
      settings = next;
      act(() => {
        for (const listener of [...settingsListeners]) {
          listener(next);
        }
      });
    },
    client: {
      getActiveTabId: () => guard('getActiveTabId', '', tabId),
      queryDetection: (id: number) => guard('queryDetection', String(id), items),
      refreshDetection: (id: number) => guard('refreshDetection', String(id), items),
      queryQueue: () => guard('queryQueue', '', tasks),
      enqueue: (itemIds: readonly string[]) => guard<void>('enqueue', itemIds.join(','), undefined),
      requestStreamAccess: (urls: readonly string[]) =>
        guard<boolean>('requestStreamAccess', urls.join(','), streamAccess),
      cancel: (id: string) => guard<void>('cancel', id, undefined),
      retry: (id: string) => guard<void>('retry', id, undefined),
      pause: (id: string) => guard<void>('pause', id, undefined),
      resume: (id: string) => guard<void>('resume', id, undefined),
      remove: (id: string) => guard<void>('remove', id, undefined),
      clearQueue: () => guard<void>('clearQueue', '', undefined),
      copyLink: (url: string) => guard<void>('copyLink', url, undefined),
      onDownloadEvent: (listener) => {
        downloadListeners.add(listener);
        subscriptions.downloads += 1;
        return () => {
          downloadListeners.delete(listener);
          subscriptions.downloads -= 1;
        };
      },
      getSettings: () => guard('getSettings', '', settings),
      onSettingsChanged: (listener) => {
        settingsListeners.add(listener);
        return () => {
          settingsListeners.delete(listener);
        };
      },
      onDetectionFinished: (listener) => {
        detectionListeners.add(listener);
        subscriptions.detection += 1;
        return () => {
          detectionListeners.delete(listener);
          subscriptions.detection -= 1;
        };
      },
    },
  };
}
