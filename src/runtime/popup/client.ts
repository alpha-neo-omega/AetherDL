/**
 * Module: runtime/popup (runtime client adapter)
 * Purpose: Implement the popup's {@link PopupRuntimeClient} port over the platform
 *          facade (PROJECT_BIBLE.md §8.5, §8.11). This is the ONLY place the popup
 *          surface touches browser capabilities: every UI intent becomes a typed
 *          message on the existing bus, and the background's broadcasts become port
 *          callbacks.
 * Restrictions: Runtime layer — thin adaptation only; no domain logic, no detection
 *          and no download behaviour (§8.1). Broadcast payloads are validated at the
 *          boundary before they reach the UI (§13.8). Every subscription returns an
 *          unsubscribe so the popup leaks no listeners on close (§12.7).
 * Public API: createPopupRuntimeClient.
 */
import type { Browser } from '@platform/browser';
import {
  DETECTION_FINISHED_CHANNEL,
  DOWNLOAD_EVENT_CHANNEL,
  SETTINGS_CHANGED_CHANNEL,
} from '@shared/constants';
import { RuntimeError } from '@shared/result/errors';
import type { DownloadEventBroadcast, DownloadTask, MediaItem, Settings } from '@shared/types';
import type { Unsubscribe } from '@shared/utils';
import type { PopupRuntimeClient } from '@ui/popup';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Accept a broadcast only once it carries the shape the UI relies on (§13.8). */
function asDownloadEvent(payload: unknown): DownloadEventBroadcast | undefined {
  return isRecord(payload) && typeof payload['event'] === 'string'
    ? (payload as unknown as DownloadEventBroadcast)
    : undefined;
}

/** A settings broadcast is trusted only once it carries the catalogue's shape. */
function asSettings(payload: unknown): Settings | undefined {
  return isRecord(payload) && typeof payload['theme'] === 'string'
    ? (payload as unknown as Settings)
    : undefined;
}

function asTabId(payload: unknown): number | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const tabId = payload['tabId'];
  return typeof tabId === 'number' && Number.isInteger(tabId) ? tabId : undefined;
}

export function createPopupRuntimeClient(browser: Browser): PopupRuntimeClient {
  const bus = browser.messaging;

  return {
    async getActiveTabId(): Promise<number | undefined> {
      const tab = await browser.tabs.getActive();
      return tab?.id;
    },

    queryDetection(tabId: number): Promise<readonly MediaItem[]> {
      return bus.send('detection/query', { tabId });
    },

    refreshDetection(tabId: number): Promise<readonly MediaItem[]> {
      return bus.send('detection/refresh', { tabId });
    },

    queryQueue(): Promise<readonly DownloadTask[]> {
      return bus.send('download/query', undefined);
    },

    enqueue(itemIds: readonly string[]): Promise<void> {
      return bus.send('download/enqueue', { itemIds });
    },

    cancel(taskId: string): Promise<void> {
      return bus.send('download/cancel', { taskId });
    },

    retry(taskId: string): Promise<void> {
      return bus.send('download/retry', { taskId });
    },

    pause(taskId: string): Promise<void> {
      return bus.send('download/pause', { taskId });
    },

    resume(taskId: string): Promise<void> {
      return bus.send('download/resume', { taskId });
    },

    remove(taskId: string): Promise<void> {
      return bus.send('download/remove', { taskId });
    },

    clearQueue(): Promise<void> {
      return bus.send('download/clear', undefined);
    },

    async copyLink(url: string): Promise<void> {
      const clipboard = globalThis.navigator?.clipboard;
      if (clipboard === undefined) {
        throw new RuntimeError('Clipboard access is unavailable in this context', {
          code: 'popup-clipboard-unavailable',
          messageKey: 'error.internal',
        });
      }
      await clipboard.writeText(url);
    },

    onDownloadEvent(listener: (event: DownloadEventBroadcast) => void): Unsubscribe {
      return bus.onBroadcast(DOWNLOAD_EVENT_CHANNEL, (payload) => {
        const event = asDownloadEvent(payload);
        if (event !== undefined) {
          listener(event);
        }
      });
    },

    getSettings(): Promise<Settings> {
      return bus.send('settings/get', undefined);
    },

    onSettingsChanged(listener: (settings: Settings) => void): Unsubscribe {
      return bus.onBroadcast(SETTINGS_CHANGED_CHANNEL, (payload) => {
        const settings = asSettings(payload);
        if (settings !== undefined) {
          listener(settings);
        }
      });
    },

    onDetectionFinished(listener: (tabId: number) => void): Unsubscribe {
      return bus.onBroadcast(DETECTION_FINISHED_CHANNEL, (payload) => {
        const tabId = asTabId(payload);
        if (tabId !== undefined) {
          listener(tabId);
        }
      });
    },
  };
}
