/**
 * Module: ui/popup (runtime client port)
 * Purpose: The boundary the popup talks to — one intent per approved `download/*`
 *          and `detection/*` message, plus the background→surface event streams
 *          (PROJECT_BIBLE.md §8.5, §8.6). This is a PORT: the UI depends on this
 *          interface, and the popup composition root in `runtime/popup` injects the
 *          concrete adapter over the platform messaging bus (dependency inversion,
 *          §8.4 rule 3).
 * Restrictions: UI layer — declares intent only. It performs no detection, no
 *          download, and no browser access; every member maps onto a message that
 *          already exists in the ratified contract (§8.5). Types come from the leaf
 *          `shared/` layer so this file imports nothing from platform/ or runtime/.
 * Public API: PopupRuntimeClient, RuntimeClientProvider, useRuntimeClient.
 */
import { createContext, createElement, useContext, type ReactNode } from 'react';
import type { DownloadEventBroadcast, DownloadTask, MediaItem, Settings } from '@shared/types';
import type { Unsubscribe } from '@shared/utils';

export interface PopupRuntimeClient {
  /** The tab the user is viewing; detection results are per-tab (§4.1). */
  getActiveTabId(): Promise<number | undefined>;
  /** `detection/query` — the background's cached results for a tab (§8.6). */
  queryDetection(tabId: number): Promise<readonly MediaItem[]>;
  /**
   * `detection/refresh` — ask the background to observe the tab again. Opening the
   * popup is the user gesture that permits it (§13.7); fresh results arrive through
   * {@link PopupRuntimeClient.onDetectionFinished}, not from this call (§4.1).
   */
  refreshDetection(tabId: number): Promise<readonly MediaItem[]>;
  /** `download/query` — the queue, the single source of truth for state (§4.4). */
  queryQueue(): Promise<readonly DownloadTask[]>;
  /** `download/enqueue` — by identity key; the background resolves the items (§8.6). */
  enqueue(itemIds: readonly string[]): Promise<void>;
  /**
   * Ask for access to the hosts a stream download will read, at the moment the user
   * asks for it (§13.7, §4.15). Resolves `true` when nothing needs asking (no stream
   * among the URLs) or the user granted it; `false` when the user declined.
   * MUST be called first in the click handler: a browser only accepts a permission
   * request from a live user gesture.
   */
  requestStreamAccess(urls: readonly string[]): Promise<boolean>;
  cancel(taskId: string): Promise<void>;
  retry(taskId: string): Promise<void>;
  pause(taskId: string): Promise<void>;
  resume(taskId: string): Promise<void>;
  remove(taskId: string): Promise<void>;
  clearQueue(): Promise<void>;
  /** Copy a media URL to the clipboard (§11.6 secondary action). */
  copyLink(url: string): Promise<void>;
  /** Runtime download lifecycle events pushed by the background (§12.4). */
  onDownloadEvent(listener: (event: DownloadEventBroadcast) => void): Unsubscribe;
  /** Fresh detection results announced for a tab (§4.1 incremental detection). */
  onDetectionFinished(listener: (tabId: number) => void): Unsubscribe;
  /** `settings/get` — the popup follows the Appearance settings live (§4.9). */
  getSettings(): Promise<Settings>;
  /** Applied settings pushed by the background so open surfaces stay in step. */
  onSettingsChanged(listener: (settings: Settings) => void): Unsubscribe;
}

const RuntimeClientContext = createContext<PopupRuntimeClient | undefined>(undefined);

export interface RuntimeClientProviderProps {
  readonly client: PopupRuntimeClient;
  readonly children: ReactNode;
}

export function RuntimeClientProvider(props: RuntimeClientProviderProps): ReactNode {
  return createElement(RuntimeClientContext.Provider, { value: props.client }, props.children);
}

/** Read the injected client. Throws when the surface was not composed correctly. */
export function useRuntimeClient(): PopupRuntimeClient {
  const client = useContext(RuntimeClientContext);
  if (client === undefined) {
    throw new Error('useRuntimeClient must be used inside a RuntimeClientProvider');
  }
  return client;
}
