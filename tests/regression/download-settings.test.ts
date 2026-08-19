/**
 * Regression (PROJECT_BIBLE.md §4.9, §10.3, §10.4, §10.7, §16.5): the background
 * composition built the Download System without the four user-configurable values,
 * so *Maximum concurrent downloads*, *Maximum retries*, *Filename template* and
 * *Download subfolder* were persisted, broadcast and displayed while having no
 * effect at all — concurrency stayed at 3, retries at 3, the template at
 * `{title}.{ext}`, and files never landed in the configured folder.
 *
 * These tests hold the wiring to the observable outcome: what the platform download
 * adapter is actually asked to do, and what the running system does after a settings
 * change arrives on the existing `settings:changed` event.
 */
import { describe, expect, it, vi } from 'vitest';
import { createDownloadSystem } from '@core/download/factory';
import { createBrowserFrom } from '@platform/browser/factory';
import { createMessageBus } from '@platform/messaging/service';
import { DEFAULT_SETTINGS } from '@core/settings';
import { createSettingsService } from '@core/settings/settings';
import { createHistoryService } from '@core/history/history';
import { createHistoryRepository } from '@core/storage/history-repository';
import type { SettingsRepository } from '@core/storage';
import type { Settings } from '@shared/types';
import {
  createBackgroundDownloadRuntime,
  createDetectionItemResolver,
} from '@runtime/background/downloads';
import { createBackgroundRuntime } from '@runtime/background/runtime';
import { createBackgroundSettingsRuntime } from '@runtime/background/settings';
import { createFakeDownloads, mediaItem, tick } from '../unit/core/download/_fixtures';
import { createMemoryObjectStore } from '../unit/core/storage/_fixtures';
import { createFakeWebExt } from '../unit/platform/_fake-webext';
import { createFakeEngine, report } from '../unit/runtime/_fixtures';

const TAB = 31;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function memorySettings(initial: Settings): SettingsRepository {
  let stored = initial;
  return {
    load: () => Promise.resolve(stored),
    save: (next) => {
      stored = next;
      return Promise.resolve();
    },
  };
}

/** The background composition, wired exactly as `runtime/background/index.ts` wires it. */
function boot(overrides: Partial<Settings> = {}) {
  const fake = createFakeWebExt();
  fake.grantedPermissions.add('downloads');
  fake.setTabs([{ id: TAB, active: true, url: 'https://example.com/watch', windowId: 1 }]);
  const browser = createBrowserFrom(fake.api, 'chrome');

  const settings = createSettingsService({
    repository: memorySettings({ ...DEFAULT_SETTINGS, ...overrides }),
  });
  const history = createHistoryService({
    repository: createHistoryRepository({ store: createMemoryObjectStore() }),
    settings,
    clock: () => 0,
    sessionStartedAt: 0,
  });

  const engine = createFakeEngine();
  const detection = createBackgroundRuntime({ browser, engine: engine.manager, clock: () => 0 });
  detection.start();

  const downloads = createBackgroundDownloadRuntime({
    browser,
    resolver: createDetectionItemResolver(detection.state),
    store: createMemoryObjectStore(),
    history,
    getSettings: () => settings.get(),
    clock: () => 0,
    random: () => 0,
  });
  downloads.start();

  const settingsRuntime = createBackgroundSettingsRuntime({ browser, settings, history });
  settingsRuntime.start();
  settingsRuntime.on('settings:changed', (applied) => {
    downloads.applySettings(applied);
  });

  const client = createMessageBus(fake.api);
  return {
    fake,
    engine,
    detection,
    downloads,
    client,
    async dispose(): Promise<void> {
      client.dispose();
      settingsRuntime.dispose();
      await downloads.dispose();
      await detection.dispose();
      browser.messaging.dispose();
    },
  };
}

/** Detect `count` distinct media items for the active tab and return their ids. */
async function detect(suite: ReturnType<typeof boot>, count: number): Promise<string[]> {
  const items = Array.from({ length: count }, (_, index) =>
    mediaItem({
      id: `item-${String(index)}`,
      url: `https://cdn.example.com/clip-${String(index)}.mp4`,
    }),
  );
  suite.engine.setItems(items);
  await suite.client.send('detection/run', report());
  await flush();
  return items.map((item) => item.id);
}

describe('regression: the configurable download system (Phase 9)', () => {
  it('applies only the values a partial change carries', async () => {
    const fake = createFakeDownloads();
    const manager = createDownloadSystem({
      downloads: fake.adapter,
      clock: () => 0,
      maxConcurrent: 2,
      filenameTemplate: '{title}.{ext}',
      downloadSubfolder: 'First',
    });

    manager.configure({ filenameTemplate: '{title}-copy.{ext}' });
    await manager.enqueue([mediaItem({ title: 'Clip', url: 'https://example.com/a.mp4' })]);
    await tick();

    // The template changed; the subfolder set at construction is untouched.
    expect(fake.started[0]?.filename).toBe('First/Clip-copy.mp4');

    manager.configure({});
    manager.configure({ downloadSubfolder: 'Second' });
    await manager.enqueue([mediaItem({ title: 'Other', url: 'https://example.com/b.mp4' })]);
    await tick();
    expect(fake.started[1]?.filename).toBe('Second/Other-copy.mp4');

    await manager.dispose();
  });
});

describe('regression: download settings never reached the manager (Phase 9)', () => {
  it('A — the configured concurrency limit bounds native downloads', async () => {
    const suite = boot({ maxConcurrentDownloads: 2 });
    await suite.downloads.ready();
    const ids = await detect(suite, 5);

    await suite.client.send('download/enqueue', { itemIds: ids });
    await flush();
    await flush();

    const queue = await suite.client.send('download/query', undefined);
    const active = queue.filter((task) => task.state === 'active').length;
    // The observable bound: the browser was asked for at most two transfers.
    expect(active).toBeLessThanOrEqual(2);
    expect(suite.fake.downloadItems.size).toBeLessThanOrEqual(2);
    expect(queue).toHaveLength(5);
    await suite.dispose();
  });

  it('A — the default still applies when nothing is configured', async () => {
    const suite = boot();
    await suite.downloads.ready();
    const ids = await detect(suite, 5);

    await suite.client.send('download/enqueue', { itemIds: ids });
    await flush();
    await flush();

    expect(suite.fake.downloadItems.size).toBeLessThanOrEqual(3);
    await suite.dispose();
  });

  it('B — maxRetries = 0 means a retryable failure is never retried', async () => {
    const fake = createFakeDownloads();
    const scheduled: number[] = [];
    const manager = createDownloadSystem({
      downloads: fake.adapter,
      clock: () => 0,
      random: () => 0,
      maxRetries: 0,
      scheduleTimer: (delayMs, callback) => {
        scheduled.push(delayMs);
        callback();
        return () => undefined;
      },
    });
    const failed = vi.fn();
    manager.on('job:failed', failed);

    const [job] = await manager.enqueue([mediaItem({ url: 'https://example.com/a.mp4' })]);
    await tick();
    const nativeId = manager.getTask(job?.id ?? '')?.nativeDownloadId ?? 0;
    fake.setItem(nativeId, { state: 'failed' });
    fake.emit({ id: nativeId, state: 'failed' });
    await tick();

    expect(scheduled).toEqual([]);
    expect(manager.getTask(job?.id ?? '')?.state).toBe('failed');
    expect(manager.getTask(job?.id ?? '')?.attempt).toBe(0);
    expect(fake.started).toHaveLength(1);
    await manager.dispose();
  });

  it('B — a non-zero maxRetries retries exactly that many times', async () => {
    const fake = createFakeDownloads();
    const manager = createDownloadSystem({
      downloads: fake.adapter,
      clock: () => 0,
      random: () => 0,
      maxRetries: 2,
      scheduleTimer: (_delayMs, callback) => {
        callback();
        return () => undefined;
      },
    });

    const [job] = await manager.enqueue([mediaItem({ url: 'https://example.com/a.mp4' })]);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await tick();
      const nativeId = manager.getTask(job?.id ?? '')?.nativeDownloadId;
      if (nativeId === undefined) {
        break;
      }
      fake.setItem(nativeId, { state: 'failed' });
      fake.emit({ id: nativeId, state: 'failed' });
      await tick();
    }

    // The first try plus two retries — three native starts, then it gives up.
    expect(fake.started).toHaveLength(3);
    expect(manager.getTask(job?.id ?? '')?.state).toBe('failed');
    await manager.dispose();
  });

  it('C — the configured filename template names the file', async () => {
    const suite = boot({ filenameTemplate: '{host}-{title}.{ext}' });
    await suite.downloads.ready();
    suite.engine.setItems([
      mediaItem({ id: 'clip', title: 'Holiday', url: 'https://cdn.example.com/clip.mp4' }),
    ]);
    await suite.client.send('detection/run', report());
    await flush();

    await suite.client.send('download/enqueue', { itemIds: ['clip'] });
    await flush();

    const [started] = [...suite.fake.downloadItems.values()];
    // `{host}` is the item's origin host as detection recorded it.
    expect(started?.filename).toBe('example.com-Holiday.mp4');
    await suite.dispose();
  });

  it('D — the configured subfolder is where the file goes', async () => {
    const suite = boot({ downloadSubfolder: 'AetherDL/Clips' });
    await suite.downloads.ready();
    suite.engine.setItems([
      mediaItem({ id: 'clip', title: 'Holiday', url: 'https://cdn.example.com/clip.mp4' }),
    ]);
    await suite.client.send('detection/run', report());
    await flush();

    await suite.client.send('download/enqueue', { itemIds: ['clip'] });
    await flush();

    const [started] = [...suite.fake.downloadItems.values()];
    expect(started?.filename).toBe('AetherDL/Clips/Holiday.mp4');
    await suite.dispose();
  });

  it('E — a settings change reaches the already-running system', async () => {
    const suite = boot();
    await suite.downloads.ready();

    // Applied through the ratified `settings/update` message, which the settings
    // runtime broadcasts as `settings:changed` — no new mechanism (§8.5, §4.9).
    await suite.client.send('settings/update', {
      maxConcurrentDownloads: 1,
      filenameTemplate: '{index}-{title}.{ext}',
      downloadSubfolder: 'Later',
    });
    await flush();

    const ids = await detect(suite, 3);
    await suite.client.send('download/enqueue', { itemIds: ids });
    await flush();
    await flush();

    // Concurrency now bounds at the new value…
    expect(suite.fake.downloadItems.size).toBe(1);
    // …and the new template and subfolder are the ones the browser was given.
    const [started] = [...suite.fake.downloadItems.values()];
    expect(started?.filename).toMatch(/^Later\/\d+-.+\.mp4$/);
    await suite.dispose();
  });

  it('E — a settings reset returns the system to the normative defaults', async () => {
    const suite = boot({ maxConcurrentDownloads: 1, filenameTemplate: '{host}.{ext}' });
    await suite.downloads.ready();

    await suite.client.send('settings/reset', undefined);
    await flush();

    suite.engine.setItems([
      mediaItem({ id: 'clip', title: 'Holiday', url: 'https://cdn.example.com/clip.mp4' }),
    ]);
    await suite.client.send('detection/run', report());
    await flush();
    await suite.client.send('download/enqueue', { itemIds: ['clip'] });
    await flush();

    // Reset travels the same `settings:changed` path, so no stale configuration is
    // left behind: the default template names the file again.
    const [started] = [...suite.fake.downloadItems.values()];
    expect(started?.filename).toBe('Holiday.mp4');
    await suite.dispose();
  });

  it('E — raising the limit mid-session lets the waiting jobs run', async () => {
    const suite = boot({ maxConcurrentDownloads: 1 });
    await suite.downloads.ready();
    const ids = await detect(suite, 3);
    await suite.client.send('download/enqueue', { itemIds: ids });
    await flush();
    expect(suite.fake.downloadItems.size).toBe(1);

    await suite.client.send('settings/update', { maxConcurrentDownloads: 3 });
    await flush();
    // Finish the running job so the scheduler pumps under the new bound.
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
    await flush();

    expect(suite.fake.downloadItems.size).toBeGreaterThan(1);
    await suite.dispose();
  });
});
