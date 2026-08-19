/**
 * Integration: the background's remaining module collaborations
 * (PROJECT_BIBLE.md §22.10 "integration for all module collaborations").
 *
 * The context menu, the notification runtime and the real history service are
 * exercised against the real detection and download runtimes over a fake
 * WebExtension namespace — the same composition `runtime/background/index.ts`
 * builds, with only the browser itself faked.
 */
import { describe, expect, it } from 'vitest';
import { createBrowserFrom } from '@platform/browser/factory';
import { createIndexedDbObjectStore } from '@platform/storage/indexeddb';
import { DEFAULT_SETTINGS } from '@core/settings';
import { createSettingsService } from '@core/settings/settings';
import { createHistoryService } from '@core/history/history';
import { createHistoryRepository, HISTORY_STORE_NAME } from '@core/storage/history-repository';
import type { SettingsRepository } from '@core/storage';
import type { Settings } from '@shared/types';
import type { AppError } from '@shared/result';
import {
  createBackgroundDownloadRuntime,
  createDetectionItemResolver,
} from '@runtime/background/downloads';
import { createBackgroundRuntime } from '@runtime/background/runtime';
import { createContextMenuRuntime } from '@runtime/background/contextmenu';
import { createNotificationRuntime } from '@runtime/background/notifications';
import { createFakeIndexedDb } from '../unit/platform/_fake-indexeddb';
import { createFakeWebExt } from '../unit/platform/_fake-webext';
import { createMemoryObjectStore } from '../unit/core/storage/_fixtures';
import { createFakeEngine, mediaItem, report } from '../unit/runtime/_fixtures';

const TAB = 21;
const NOW = 1_700_000_000_000;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function memorySettings(initial?: Settings): SettingsRepository {
  let stored = initial;
  return {
    load: () => Promise.resolve(stored),
    save: (next) => {
      stored = next;
      return Promise.resolve();
    },
  };
}

function boot(options: { readonly settings?: Partial<Settings> } = {}) {
  const fake = createFakeWebExt({ contextMenus: true, notifications: true });
  fake.grantedPermissions.add('downloads');
  fake.grantedPermissions.add('contextMenus');
  fake.grantedPermissions.add('notifications');
  fake.setTabs([{ id: TAB, active: true, url: 'https://example.com/watch', windowId: 1 }]);

  const browser = createBrowserFrom(fake.api, 'chrome');
  const errors: AppError[] = [];
  const engine = createFakeEngine();
  const detection = createBackgroundRuntime({ browser, engine: engine.manager, clock: () => NOW });
  detection.start();

  const settings = createSettingsService({
    repository: memorySettings({ ...DEFAULT_SETTINGS, ...options.settings }),
  });
  const idb = createFakeIndexedDb();
  const history = createHistoryService({
    repository: createHistoryRepository({
      store: createIndexedDbObjectStore({
        databaseName: 'aetherdl-history',
        storeName: HISTORY_STORE_NAME,
        factory: idb.factory,
      }),
    }),
    settings,
    clock: () => NOW,
    sessionStartedAt: NOW,
  });

  let jobs = 0;
  const downloads = createBackgroundDownloadRuntime({
    browser,
    resolver: createDetectionItemResolver(detection.state),
    store: createMemoryObjectStore(),
    history,
    clock: () => NOW,
    random: () => 0,
    generateId: () => {
      jobs += 1;
      return `job-${String(jobs)}`;
    },
  });
  downloads.start();

  const contextMenu = createContextMenuRuntime({
    browser,
    getSettings: () => settings.get(),
    getActiveItems: () => {
      const tabId = detection.state.activeTabId();
      return tabId === undefined ? [] : detection.state.getItems(tabId);
    },
    enqueue: (itemIds) => downloads.enqueue(itemIds),
    entryTitle: (item) => `Download with AetherDL: ${item.title}`,
    onError: (error) => errors.push(error),
  });
  contextMenu.start();

  const notifications = createNotificationRuntime({
    browser,
    downloads,
    getSettings: () => settings.get(),
    copy: {
      completed: (task) => ({ title: 'Download complete', message: task.filename }),
      failed: (task) => ({ title: 'Download failed', message: task.filename }),
      queueCompleted: (summary) => ({
        title: 'Downloads finished',
        message: `${String(summary.completed)} done`,
      }),
    },
    onError: (error) => errors.push(error),
    iconUrl: 'icons/icon-48.png',
  });
  notifications.start();

  // The composition root keeps the menu in step with detection (§4.13).
  detection.on('detection:finished', () => {
    void contextMenu.sync();
  });

  return {
    fake,
    engine,
    errors,
    detection,
    downloads,
    settings,
    history,
    contextMenu,
    notifications,
    async dispose(): Promise<void> {
      notifications.dispose();
      await contextMenu.dispose();
      await downloads.dispose();
      await detection.dispose();
      browser.messaging.dispose();
    },
  };
}

describe('background integration: context menu → download', () => {
  it('offers the active tab’s media and downloads the entry the user picks', async () => {
    const suite = boot();
    suite.engine.setItems([mediaItem({ id: 'clip', title: 'Holiday Clip' })]);
    suite.fake.onActivated.trigger({ tabId: TAB, windowId: 1 });

    await suite.fake.api.runtime.sendMessage({
      __aetherdl_msg__: true,
      kind: 'request',
      type: 'detection/run',
      payload: report(),
      id: 'menu-1',
    });
    await flush();

    const entries = [...suite.fake.menuItems.values()];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]?.title).toContain('Holiday Clip');

    const [id] = [...suite.fake.menuItems.keys()];
    suite.fake.onMenuClicked.trigger({ menuItemId: id ?? '' });
    await flush();

    // The click travelled menu → download runtime → native downloads (§4.13, §10).
    expect(suite.fake.downloadItems.size).toBe(1);
    expect(suite.errors).toEqual([]);
    await suite.dispose();
  });
});

describe('background integration: download → notification', () => {
  it('notifies on completion, and stays silent when the user turned it off', async () => {
    const loud = boot();
    loud.engine.setItems([mediaItem({ id: 'clip', title: 'Holiday Clip' })]);
    await loud.fake.api.runtime.sendMessage({
      __aetherdl_msg__: true,
      kind: 'request',
      type: 'detection/run',
      payload: report(),
      id: 'notify-1',
    });
    await flush();
    await loud.downloads.enqueue(['clip']);
    await flush();
    for (const [id] of loud.fake.downloadItems) {
      loud.fake.downloadItems.set(id, {
        id,
        state: 'complete',
        bytesReceived: 10,
        totalBytes: 10,
        filename: 'clip.mp4',
      });
      loud.fake.onDownloadChanged.trigger({ id, state: { current: 'complete' } });
    }
    await flush();

    // One for the finished job, one for the queue draining (§4.14).
    const shown = [...loud.fake.notifications.values()].map((entry) => entry.title);
    expect(shown).toContain('Download complete');
    expect(loud.fake.notifications.size).toBeGreaterThanOrEqual(1);
    await loud.dispose();

    const quiet = boot({ settings: { notifications: false } });
    quiet.engine.setItems([mediaItem({ id: 'clip', title: 'Holiday Clip' })]);
    await quiet.fake.api.runtime.sendMessage({
      __aetherdl_msg__: true,
      kind: 'request',
      type: 'detection/run',
      payload: report(),
      id: 'notify-2',
    });
    await flush();
    await quiet.downloads.enqueue(['clip']);
    await flush();
    for (const [id] of quiet.fake.downloadItems) {
      quiet.fake.downloadItems.set(id, {
        id,
        state: 'complete',
        bytesReceived: 10,
        totalBytes: 10,
        filename: 'clip.mp4',
      });
      quiet.fake.onDownloadChanged.trigger({ id, state: { current: 'complete' } });
    }
    await flush();

    expect(quiet.fake.notifications.size).toBe(0);
    await quiet.dispose();
  });
});

describe('background integration: download → history over the real service', () => {
  it('records a completed transfer in IndexedDB-backed history', async () => {
    const suite = boot();
    suite.engine.setItems([mediaItem({ id: 'clip', title: 'Holiday Clip' })]);
    await suite.fake.api.runtime.sendMessage({
      __aetherdl_msg__: true,
      kind: 'request',
      type: 'detection/run',
      payload: report(),
      id: 'history-1',
    });
    await flush();

    await suite.downloads.enqueue(['clip']);
    await flush();
    for (const [id] of suite.fake.downloadItems) {
      suite.fake.downloadItems.set(id, {
        id,
        state: 'complete',
        bytesReceived: 10,
        totalBytes: 10,
        filename: 'clip.mp4',
      });
      suite.fake.onDownloadChanged.trigger({ id, state: { current: 'complete' } });
    }
    await flush();

    const records = await suite.history.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: 'completed', title: 'Holiday Clip' });
    await suite.dispose();
  });

  it('writes nothing when the user keeps no history', async () => {
    const suite = boot({ settings: { keepHistory: false } });
    suite.engine.setItems([mediaItem({ id: 'clip', title: 'Holiday Clip' })]);
    await suite.fake.api.runtime.sendMessage({
      __aetherdl_msg__: true,
      kind: 'request',
      type: 'detection/run',
      payload: report(),
      id: 'history-2',
    });
    await flush();

    await suite.downloads.enqueue(['clip']);
    await flush();
    for (const [id] of suite.fake.downloadItems) {
      suite.fake.downloadItems.set(id, {
        id,
        state: 'complete',
        bytesReceived: 10,
        totalBytes: 10,
        filename: 'clip.mp4',
      });
      suite.fake.onDownloadChanged.trigger({ id, state: { current: 'complete' } });
    }
    await flush();

    expect(await suite.history.list()).toEqual([]);
    await suite.dispose();
  });
});
