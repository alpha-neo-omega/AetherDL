/**
 * Performance: every runtime releases what it took (PROJECT_BIBLE.md §12.7, §12.8).
 *
 * A surface is opened and closed over and over in a browser session. If a single
 * listener, menu entry, timer or per-tab record survives a teardown, the leak
 * compounds. Each suite here runs many open/close cycles against ONE fake
 * WebExtension namespace and asserts the observable resource census returns to its
 * pre-cycle baseline every time.
 */
import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repoRoot } from '../../build/vite/aliases';
import { createBrowserFrom } from '@platform/browser/factory';
import { createMessageBus } from '@platform/messaging/service';
import { createDetectionEngine } from '@core/detection/factory';
import { createHistoryService } from '@core/history/history';
import { createHistoryRepository } from '@core/storage/history-repository';
import { createSettingsService } from '@core/settings/settings';
import { DEFAULT_SETTINGS } from '@core/settings';
import type { SettingsRepository } from '@core/storage';
import type { QueueStats } from '@core/download/queue';
import type { Settings } from '@shared/types';
import { TypedEventEmitter } from '@shared/utils';
import {
  createBackgroundDownloadRuntime,
  createDetectionItemResolver,
  type BackgroundDownloadRuntime,
  type DownloadRuntimeEventMap,
} from '@runtime/background/downloads';
import { createBackgroundRuntime } from '@runtime/background/runtime';
import { createBackgroundSettingsRuntime } from '@runtime/background/settings';
import { createContextMenuRuntime } from '@runtime/background/contextmenu';
import { createNotificationRuntime } from '@runtime/background/notifications';
import { createPopupRuntimeClient } from '@runtime/popup/client';
import { createMemoryObjectStore } from '../unit/core/storage/_fixtures';
import { createFakeWebExt, FakeEvent, type FakeWebExt } from '../unit/platform/_fake-webext';
import { mediaItem } from '../unit/runtime/_fixtures';

/** Enough repetitions that a one-per-cycle leak is unmistakable. */
const CYCLES = 25;

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Every listener the extension could have attached to the browser, by event name.
 * A leak shows up as a count that climbs cycle over cycle.
 */
function census(fake: FakeWebExt): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [name, value] of Object.entries(fake)) {
    if (value instanceof FakeEvent) {
      counts[name] = value.size;
    }
  }
  return counts;
}

function total(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

function memorySettings(): SettingsRepository {
  let stored: Settings | undefined;
  return {
    load: () => Promise.resolve(stored),
    save: (next) => {
      stored = next;
      return Promise.resolve();
    },
  };
}

const EMPTY_STATS: QueueStats = {
  total: 0,
  queued: 0,
  preparing: 0,
  active: 0,
  paused: 0,
  retrying: 0,
  canceling: 0,
  completed: 0,
  failed: 0,
  canceled: 0,
  removed: 0,
};

describe('resource cleanup: background detection runtime', () => {
  it('leaves no listener behind across repeated open/close cycles', async () => {
    const fake = createFakeWebExt();
    fake.setTabs([{ id: 1, active: true, url: 'https://example.com/watch', windowId: 1 }]);
    const baseline = census(fake);
    expect(total(baseline)).toBe(0);

    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      const browser = createBrowserFrom(fake.api, 'chrome');
      const runtime = createBackgroundRuntime({
        browser,
        engine: createDetectionEngine({ clock: () => 0 }),
        clock: () => 0,
      });
      runtime.start();

      // Exercise it the way a session would: detect, navigate, close tabs.
      await browser.messaging.send('detection/run', {
        pageUrl: 'https://example.com/watch',
        domSignals: [{ role: 'video', tagName: 'VIDEO', src: 'https://cdn.example.com/clip.mp4' }],
        observedUrls: [],
      });
      fake.onUpdated.trigger(1, { url: 'https://example.com/next' }, { id: 1, active: true });
      fake.onTabRemoved.trigger(1, { windowId: 1, isWindowClosing: false });

      await runtime.dispose();
      browser.messaging.dispose();

      expect(census(fake), `cycle ${String(cycle)}`).toEqual(baseline);
    }
  });

  it('drops every per-tab record when tabs close', async () => {
    const fake = createFakeWebExt();
    const browser = createBrowserFrom(fake.api, 'chrome');
    const runtime = createBackgroundRuntime({
      browser,
      engine: createDetectionEngine({ clock: () => 0 }),
      clock: () => 0,
    });
    runtime.start();

    for (let tabId = 1; tabId <= 1000; tabId += 1) {
      fake.onTabCreated.trigger({ id: tabId, active: false, url: 'https://example.com' });
      fake.onActivated.trigger({ tabId, windowId: 1 });
    }
    expect(runtime.state.tabs()).toHaveLength(1000);

    for (let tabId = 1; tabId <= 1000; tabId += 1) {
      fake.onTabRemoved.trigger(tabId, { windowId: 1, isWindowClosing: false });
    }

    // Per-tab state is released — nothing is retained for a tab the browser no
    // longer has (§12.8). The badge cache is released too: it suppresses repeat
    // writes, so a retained entry would silently skip the badge write when the id
    // is reused. Clearing the browser-side record and reopening proves it is gone.
    expect(runtime.state.tabs()).toHaveLength(0);
    fake.action.badgeText.clear();
    fake.onTabCreated.trigger({ id: 1, active: false, url: 'https://example.com' });
    fake.onActivated.trigger({ tabId: 1, windowId: 1 });
    await flush();
    expect(fake.action.badgeText.has(1)).toBe(true);

    await runtime.dispose();
  });

  it('stops answering messages once disposed', async () => {
    const fake = createFakeWebExt();
    const browser = createBrowserFrom(fake.api, 'chrome');
    const runtime = createBackgroundRuntime({
      browser,
      engine: createDetectionEngine({ clock: () => 0 }),
      clock: () => 0,
    });
    runtime.start();
    const client = createMessageBus(fake.api);

    await expect(client.send('detection/query', { tabId: 1 })).resolves.toEqual([]);
    await runtime.dispose();
    await expect(client.send('detection/query', { tabId: 1 })).rejects.toThrow();

    client.dispose();
    browser.messaging.dispose();
  });

  it('tolerates repeated dispose without re-releasing', async () => {
    const fake = createFakeWebExt();
    const browser = createBrowserFrom(fake.api, 'chrome');
    const runtime = createBackgroundRuntime({
      browser,
      engine: createDetectionEngine({ clock: () => 0 }),
      clock: () => 0,
    });
    runtime.start();
    await runtime.dispose();
    await runtime.dispose();
    await runtime.dispose();
    browser.messaging.dispose();
    expect(total(census(fake))).toBe(0);
  });
});

describe('resource cleanup: background download runtime', () => {
  it('leaves no listener behind across repeated open/close cycles', async () => {
    const fake = createFakeWebExt();
    fake.grantedPermissions.add('downloads');
    fake.setTabs([{ id: 7, active: true, url: 'https://example.com/watch', windowId: 1 }]);
    const baseline = census(fake);

    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      const browser = createBrowserFrom(fake.api, 'chrome');
      const detection = createBackgroundRuntime({
        browser,
        engine: createDetectionEngine({ clock: () => 0 }),
        clock: () => 0,
      });
      detection.start();
      const downloads = createBackgroundDownloadRuntime({
        browser,
        resolver: createDetectionItemResolver(detection.state),
        store: createMemoryObjectStore(),
        clock: () => 1000,
        random: () => 0,
      });
      downloads.start();
      await flush();

      // Native progress arriving mid-session must not pin anything either.
      fake.onDownloadChanged.trigger({ id: 1, state: { current: 'complete' } });
      await flush();

      await downloads.dispose();
      await detection.dispose();
      browser.messaging.dispose();

      expect(census(fake), `cycle ${String(cycle)}`).toEqual(baseline);
    }
  });

  it('tolerates repeated dispose', async () => {
    const fake = createFakeWebExt();
    const browser = createBrowserFrom(fake.api, 'chrome');
    const downloads = createBackgroundDownloadRuntime({
      browser,
      resolver: { resolve: () => [] },
      store: createMemoryObjectStore(),
    });
    downloads.start();
    await flush();
    await downloads.dispose();
    await downloads.dispose();
    browser.messaging.dispose();
    expect(total(census(fake))).toBe(0);
  });
});

describe('resource cleanup: settings, menus and notifications', () => {
  it('settings runtime leaves no listener behind across cycles', async () => {
    const fake = createFakeWebExt();
    const baseline = census(fake);

    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      const browser = createBrowserFrom(fake.api, 'chrome');
      const settings = createSettingsService({ repository: memorySettings() });
      const runtime = createBackgroundSettingsRuntime({
        browser,
        settings,
        history: createHistoryService({
          repository: createHistoryRepository({ store: createMemoryObjectStore() }),
          settings,
          clock: () => 0,
          sessionStartedAt: 0,
        }),
      });
      runtime.start();
      await browser.messaging.send('settings/get', undefined);
      runtime.dispose();
      browser.messaging.dispose();

      expect(census(fake), `cycle ${String(cycle)}`).toEqual(baseline);
    }
  });

  it('context menu runtime removes its entries and listener every cycle', async () => {
    const fake = createFakeWebExt({ contextMenus: true });
    fake.grantedPermissions.add('contextMenus');
    const baseline = census(fake);

    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      const browser = createBrowserFrom(fake.api, 'chrome');
      const runtime = createContextMenuRuntime({
        browser,
        getSettings: () => Promise.resolve(DEFAULT_SETTINGS),
        getActiveItems: () => [mediaItem({ id: `m-${String(cycle)}` })],
        enqueue: () => Promise.resolve(),
        entryTitle: (item) => item.title,
        onError: () => undefined,
      });
      runtime.start();
      await runtime.sync();
      expect(fake.menuItems.size).toBeGreaterThan(0);

      await runtime.dispose();
      browser.messaging.dispose();

      // Menu entries are browser-global: a leaked entry would be visible to the user
      // and would duplicate on the next start (§12.8).
      expect(fake.menuItems.size, `cycle ${String(cycle)}`).toBe(0);
      expect(census(fake), `cycle ${String(cycle)}`).toEqual(baseline);
    }
  });

  it('notification runtime leaves no listener behind across cycles', async () => {
    const fake = createFakeWebExt({ notifications: true });
    fake.grantedPermissions.add('notifications');
    const baseline = census(fake);

    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      const browser = createBrowserFrom(fake.api, 'chrome');
      const emitter = new TypedEventEmitter<DownloadRuntimeEventMap>();
      const downloads = {
        on: emitter.on.bind(emitter),
        snapshot: () => ({ stats: EMPTY_STATS, health: {}, retries: [] }),
      } as unknown as BackgroundDownloadRuntime;

      const runtime = createNotificationRuntime({
        browser,
        downloads,
        getSettings: () => Promise.resolve(DEFAULT_SETTINGS),
        copy: {
          completed: (job) => ({ title: 'done', message: job.filename }),
          failed: (job) => ({ title: 'failed', message: job.filename }),
          queueCompleted: () => ({ title: 'queue', message: 'done' }),
        },
        onError: () => undefined,
        iconUrl: 'icons/icon-48.png',
      });
      runtime.start();
      await flush();
      runtime.dispose();
      browser.messaging.dispose();

      expect(census(fake), `cycle ${String(cycle)}`).toEqual(baseline);
    }
  });
});

describe('resource cleanup: popup surface', () => {
  it('releases every subscription when the popup closes', () => {
    const fake = createFakeWebExt();
    const browser = createBrowserFrom(fake.api, 'chrome');
    const baselineAfterBus = census(fake);

    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      const client = createPopupRuntimeClient(browser);
      const off = [
        client.onDownloadEvent(() => undefined),
        client.onSettingsChanged(() => undefined),
        client.onDetectionFinished(() => undefined),
      ];
      // Opening the popup attaches at most the bus's single router listener.
      expect(total(census(fake))).toBeLessThanOrEqual(total(baselineAfterBus) + 1);
      for (const unsubscribe of off) {
        unsubscribe();
      }
    }

    browser.messaging.dispose();
    expect(total(census(fake))).toBe(0);
  });

  it('stops delivering broadcasts to a closed popup', async () => {
    const fake = createFakeWebExt();
    const browser = createBrowserFrom(fake.api, 'chrome');
    const client = createPopupRuntimeClient(browser);
    const seen: unknown[] = [];
    const off = client.onDownloadEvent((event) => seen.push(event));

    const publisher = createMessageBus(fake.api);
    await publisher.broadcast('download/event', { event: 'queue:changed' });
    expect(seen).toHaveLength(1);

    off();
    await publisher.broadcast('download/event', { event: 'queue:changed' });
    expect(seen).toHaveLength(1);

    publisher.dispose();
    browser.messaging.dispose();
  });
});

describe('idle cost: the background does nothing when nothing happens', () => {
  it('schedules no timer at rest', async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeWebExt();
      fake.grantedPermissions.add('downloads');
      const browser = createBrowserFrom(fake.api, 'chrome');
      const detection = createBackgroundRuntime({
        browser,
        engine: createDetectionEngine({ clock: () => 0 }),
        clock: () => 0,
      });
      detection.start();
      const downloads = createBackgroundDownloadRuntime({
        browser,
        resolver: createDetectionItemResolver(detection.state),
        store: createMemoryObjectStore(),
      });
      downloads.start();
      await vi.runAllTimersAsync();

      // An idle background holds no pending timer, so it costs ~0% CPU and lets a
      // Chromium service worker suspend (§12.5, §8.9).
      expect(vi.getTimerCount()).toBe(0);

      await downloads.dispose();
      await detection.dispose();
      browser.messaging.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ships no polling loop anywhere in the source tree', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
        } else if (/\.tsx?$/.test(entry.name)) {
          const source = readFileSync(path, 'utf8');
          for (const pattern of [/\bsetInterval\s*\(/, /\brequestIdleCallback\s*\(/]) {
            if (pattern.test(source)) {
              offenders.push(`${path}: ${pattern.source}`);
            }
          }
        }
      }
    };
    walk(resolve(repoRoot, 'src'));

    // A periodic timer would keep the service worker alive and burn CPU forever;
    // every AetherDL code path is event-driven (§12.5, §8.9).
    expect(offenders).toEqual([]);
  });
});
