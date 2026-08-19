/**
 * Module: platform/tabs
 * Purpose: Tab / active-tab / window query and event contract (PROJECT_BIBLE.md
 *          §4.7). Implementation in ./service.
 * Restrictions: Platform layer — depends only on shared/ (§8.4). No product logic.
 * Dependencies: shared/utils (Unsubscribe).
 * Public API: TabInfo, WindowInfo, TabsAdapter.
 */
import type { Unsubscribe } from '@shared/utils';

export interface TabInfo {
  readonly id: number;
  readonly url: string | undefined;
  readonly active: boolean;
  readonly windowId: number | undefined;
}

export interface WindowInfo {
  readonly id: number | undefined;
  readonly focused: boolean;
}

/** A tab that replaced another (prerender/instant navigation swap). */
export interface TabReplacement {
  readonly addedTabId: number;
  readonly removedTabId: number;
}

export interface TabsAdapter {
  /** The active tab in the current window, or `undefined` when none/queryless. */
  getActive(): Promise<TabInfo | undefined>;
  /** The current window. */
  getCurrentWindow(): Promise<WindowInfo>;
  /** Fires with the newly activated tab id. */
  onActivated(listener: (tabId: number) => void): Unsubscribe;
  /** Fires on any tab update (status/url changes). */
  onUpdated(listener: (tab: TabInfo) => void): Unsubscribe;
  /** Fires only on navigations to a valid http(s) URL (§13.5). */
  onNavigated(listener: (tab: TabInfo) => void): Unsubscribe;
  // --- Tab lifecycle (ratified additive extension; existing methods unchanged) ---
  /** Fires when a tab is created. */
  onCreated(listener: (tab: TabInfo) => void): Unsubscribe;
  /** Fires with the id of a removed tab. */
  onRemoved(listener: (tabId: number) => void): Unsubscribe;
  /** Fires with the id of a tab attached to a window. */
  onAttached(listener: (tabId: number) => void): Unsubscribe;
  /** Fires with the id of a tab detached from a window. */
  onDetached(listener: (tabId: number) => void): Unsubscribe;
  /** Fires when one tab replaces another (added/removed ids). */
  onReplaced(listener: (replacement: TabReplacement) => void): Unsubscribe;
}
