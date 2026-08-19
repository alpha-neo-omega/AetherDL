/**
 * Module: platform/tabs (implementation)
 * Purpose: Implement the {@link TabsAdapter} over the normalized WebExtension API.
 * Restrictions: Platform layer — adapts only; no product logic. Events are
 *          multiplexed from a single upstream listener and detach at zero (no leak).
 * Public API: createTabsService.
 */
import type { TabInfo, TabReplacement, TabsAdapter, WindowInfo } from '@platform/tabs';
import type { WebExtApi, WebExtTab } from '@platform/browser/webext';
import { TabError } from '@shared/result/errors';
import { createMultiplexer, isDownloadableUrl } from '@shared/utils';

function toTabInfo(tab: WebExtTab): TabInfo | undefined {
  if (tab.id === undefined) {
    return undefined;
  }
  return { id: tab.id, url: tab.url, active: tab.active ?? false, windowId: tab.windowId };
}

function toTabInfoWithId(tabId: number, tab: WebExtTab): TabInfo {
  return { id: tabId, url: tab.url, active: tab.active ?? false, windowId: tab.windowId };
}

/** Create the tabs service over a resolved WebExtension API. */
export function createTabsService(api: WebExtApi): TabsAdapter {
  const activated = createMultiplexer<[number]>((emit) => {
    const listener = (info: { tabId: number }): void => {
      emit(info.tabId);
    };
    api.tabs.onActivated.addListener(listener);
    return () => {
      api.tabs.onActivated.removeListener(listener);
    };
  });

  const updated = createMultiplexer<[TabInfo, boolean]>((emit) => {
    const listener = (
      tabId: number,
      changeInfo: { url?: string; status?: string },
      tab: WebExtTab,
    ): void => {
      emit(toTabInfoWithId(tabId, tab), changeInfo.url !== undefined);
    };
    api.tabs.onUpdated.addListener(listener);
    return () => {
      api.tabs.onUpdated.removeListener(listener);
    };
  });

  const created = createMultiplexer<[TabInfo]>((emit) => {
    const listener = (tab: WebExtTab): void => {
      const info = toTabInfo(tab);
      if (info !== undefined) {
        emit(info);
      }
    };
    api.tabs.onCreated.addListener(listener);
    return () => {
      api.tabs.onCreated.removeListener(listener);
    };
  });

  const removed = createMultiplexer<[number]>((emit) => {
    const listener = (tabId: number): void => {
      emit(tabId);
    };
    api.tabs.onRemoved.addListener(listener);
    return () => {
      api.tabs.onRemoved.removeListener(listener);
    };
  });

  const attached = createMultiplexer<[number]>((emit) => {
    const listener = (tabId: number): void => {
      emit(tabId);
    };
    api.tabs.onAttached.addListener(listener);
    return () => {
      api.tabs.onAttached.removeListener(listener);
    };
  });

  const detached = createMultiplexer<[number]>((emit) => {
    const listener = (tabId: number): void => {
      emit(tabId);
    };
    api.tabs.onDetached.addListener(listener);
    return () => {
      api.tabs.onDetached.removeListener(listener);
    };
  });

  const replaced = createMultiplexer<[TabReplacement]>((emit) => {
    const listener = (addedTabId: number, removedTabId: number): void => {
      emit({ addedTabId, removedTabId });
    };
    api.tabs.onReplaced.addListener(listener);
    return () => {
      api.tabs.onReplaced.removeListener(listener);
    };
  });

  return {
    async getActive(): Promise<TabInfo | undefined> {
      try {
        const tabs = await api.tabs.query({ active: true, currentWindow: true });
        const first = tabs[0];
        return first === undefined ? undefined : toTabInfo(first);
      } catch (cause) {
        throw new TabError('Failed to query the active tab', {
          code: 'tab-query-failed',
          messageKey: 'error.tab.query',
          cause,
        });
      }
    },

    async getCurrentWindow(): Promise<WindowInfo> {
      try {
        const window = await api.windows.getCurrent();
        return { id: window.id, focused: window.focused ?? false };
      } catch (cause) {
        throw new TabError('Failed to query the current window', {
          code: 'window-query-failed',
          messageKey: 'error.tab.window',
          cause,
        });
      }
    },

    onActivated(listener: (tabId: number) => void) {
      return activated.subscribe(listener);
    },

    onUpdated(listener: (tab: TabInfo) => void) {
      return updated.subscribe((tab) => {
        listener(tab);
      });
    },

    onNavigated(listener: (tab: TabInfo) => void) {
      return updated.subscribe((tab, urlChanged) => {
        if (urlChanged && tab.url !== undefined && isDownloadableUrl(tab.url)) {
          listener(tab);
        }
      });
    },

    onCreated(listener: (tab: TabInfo) => void) {
      return created.subscribe(listener);
    },

    onRemoved(listener: (tabId: number) => void) {
      return removed.subscribe(listener);
    },

    onAttached(listener: (tabId: number) => void) {
      return attached.subscribe(listener);
    },

    onDetached(listener: (tabId: number) => void) {
      return detached.subscribe(listener);
    },

    onReplaced(listener: (replacement: TabReplacement) => void) {
      return replaced.subscribe(listener);
    },
  };
}
