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
import type {
  DownloadEventBroadcast,
  DownloadTask,
  MediaItem,
  Settings,
  StreamRenditionSnapshot,
} from '@shared/types';
import { manifestTypeFromUrl, parseUrl, type Unsubscribe } from '@shared/utils';
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
  /**
   * The origin of the tab the popup was opened over, captured when the popup reads
   * the active tab at load. Opening the popup is the gesture that activates
   * `activeTab`, which already grants access to THAT origin — so a stream served by
   * the page itself needs no second prompt (§13.7, §4.15). Cached because the check
   * happens inside a click handler, where an await would spend the user gesture the
   * permission request needs.
   */
  let activeOrigin: string | undefined;

  return {
    async getActiveTabId(): Promise<number | undefined> {
      const tab = await browser.tabs.getActive();
      activeOrigin = tab?.url === undefined ? undefined : parseUrl(tab.url)?.origin;
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

    enqueue(itemIds: readonly string[], renditionId?: string): Promise<void> {
      return bus.send('download/enqueue', {
        itemIds,
        ...(renditionId !== undefined && { renditionId }),
      });
    },

    listStreamQualities(manifestUrl: string): Promise<readonly StreamRenditionSnapshot[]> {
      return bus.send('stream/qualities', { manifestUrl });
    },

    /**
     * Only stream manifests need host access — a progressive file is saved by the
     * browser itself, which needs no permission from us (§10.8). The request names
     * the origins actually in play, never a broad pattern (§13.7), skips the tab's
     * own origin (already covered by `activeTab`), and is issued without awaiting
     * anything first so the user gesture is still live.
     */
    requestStreamAccess(urls: readonly string[]): Promise<boolean> {
      const origins = new Set<string>();
      for (const url of urls) {
        if (manifestTypeFromUrl(url) === undefined) {
          continue;
        }
        const parsed = parseUrl(url);
        if (parsed !== undefined && parsed.origin !== activeOrigin) {
          origins.add(`${parsed.origin}/*`);
        }
      }
      if (origins.size === 0) {
        return Promise.resolve(true);
      }
      return browser.permissions.requestHosts([...origins]);
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
