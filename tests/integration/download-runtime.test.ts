/**
 * Integration: the background runtime end to end — a content-script detection
 * report becomes a queued download, drives native progress and completion, records
 * history, survives a simulated service-worker teardown, and reconstructs its
 * durable queue on the next wake (PROJECT_BIBLE.md §8.6, §8.9, §10).
 */
import { describe, expect, it } from 'vitest';
import { createBrowserFrom } from '@platform/browser/factory';
import { createMessageBus } from '@platform/messaging/service';
import type { HistoryService } from '@core/history';
import type { DownloadEventBroadcast, HistoryRecord } from '@shared/types';
import {
  createBackgroundDownloadRuntime,
  createDetectionItemResolver,
  DOWNLOAD_EVENT_CHANNEL,
} from '@runtime/background/downloads';
import { createBackgroundRuntime } from '@runtime/background/runtime';
import { createMemoryObjectStore, type MemoryObjectStore } from '../unit/core/storage/_fixtures';
import { createFakeWebExt } from '../unit/platform/_fake-webext';
import { createFakeEngine, mediaItem, report } from '../unit/runtime/_fixtures';

const TAB = 11;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function createHistory(): { readonly service: HistoryService; readonly records: HistoryRecord[] } {
  const records: HistoryRecord[] = [];
  return {
    records,
    service: {
      record: (entry) => {
        records.push(entry);
        return Promise.resolve();
      },
      list: () => Promise.resolve(records),
      delete: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    },
  };
}

function boot(store: MemoryObjectStore) {
  const fake = createFakeWebExt();
  fake.grantedPermissions.add('downloads');
  fake.setTabs([{ id: TAB, active: true, url: 'https://example.com/watch', windowId: 1 }]);
  const browser = createBrowserFrom(fake.api, 'chrome');
  const engine = createFakeEngine();
  const detection = createBackgroundRuntime({ browser, engine: engine.manager, clock: () => 0 });
  detection.start();
  const history = createHistory();
  let counter = 0;
  const downloads = createBackgroundDownloadRuntime({
    browser,
    resolver: createDetectionItemResolver(detection.state),
    store,
    history: history.service,
    clock: () => 1000,
    random: () => 0,
    generateId: () => {
      counter += 1;
      return `job-${counter}`;
    },
  });
  downloads.start();
  const client = createMessageBus(fake.api);
  const broadcasts: DownloadEventBroadcast[] = [];
  client.onBroadcast(DOWNLOAD_EVENT_CHANNEL, (payload) => {
    broadcasts.push(payload as DownloadEventBroadcast);
  });
  return { fake, engine, detection, downloads, client, history, broadcasts };
}

describe('background runtime: detection → download', () => {
  it('carries a detected item through validation, queue, progress and completion', async () => {
    const store = createMemoryObjectStore();
    const { fake, engine, client, history, broadcasts } = boot(store);
    engine.setItems([mediaItem({ id: 'clip', url: 'https://example.com/clip.mp4' })]);

    // Content script reports the page; the background detects and caches per tab.
    const detected = await client.send('detection/run', report());
    expect(detected.map((item) => item.id)).toEqual(['clip']);

    // Popup enqueues by identity key; the background resolves and downloads.
    await client.send('download/enqueue', { itemIds: ['clip'] });
    await flush();
    expect(fake.downloadItems.size).toBe(1);

    fake.downloadItems.set(1, {
      id: 1,
      state: 'in_progress',
      bytesReceived: 60,
      totalBytes: 120,
      filename: 'Video.mp4',
    });
    fake.onDownloadChanged.trigger({ id: 1, state: { current: 'in_progress' } });
    await flush();

    const progress = await client.send('download/progress', undefined);
    expect(progress[0]).toMatchObject({ taskId: 'job-1', bytesReceived: 60, progress: 0.5 });

    fake.downloadItems.set(1, {
      id: 1,
      state: 'complete',
      bytesReceived: 120,
      totalBytes: 120,
      filename: 'Video.mp4',
    });
    fake.onDownloadChanged.trigger({ id: 1, state: { current: 'complete' } });
    await flush();

    const stats = await client.send('download/stats', undefined);
    expect(stats).toMatchObject({ total: 1, completed: 1, active: 0 });
    expect(history.records).toEqual([
      expect.objectContaining({ id: 'job-1', outcome: 'completed', originHost: 'example.com' }),
    ]);
    // The startup `queue:paused` fires while the runtime registers, before this
    // client subscribes; the first event a surface sees is the queue going live.
    expect(broadcasts.map((event) => event.event)).toEqual([
      'queue:resumed',
      'download:queued',
      'download:preparing',
      'download:started',
      'download:progress',
      'download:completed',
      'queue:completed',
    ]);
  });

  it('reconstructs the queue after a background teardown and resumes the transfer', async () => {
    const store = createMemoryObjectStore();
    const first = boot(store);
    first.engine.setItems([mediaItem({ id: 'clip', url: 'https://example.com/clip.mp4' })]);
    await first.client.send('detection/run', report());
    await first.client.send('download/enqueue', { itemIds: ['clip'] });
    await flush();
    expect(first.downloads.snapshot().stats.active).toBe(1);

    // Service worker torn down: runtimes disposed, durable store untouched.
    await first.downloads.dispose();
    await first.detection.dispose();
    expect(store.records.size).toBe(1);

    // Next wake: a brand-new process over the same durable store.
    const second = boot(store);
    second.fake.onStartup.trigger();
    await second.downloads.ready();
    await flush();

    expect(second.downloads.state.health().hydratedJobs).toBe(1);
    const tasks = await second.client.send('download/query', undefined);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.item.url).toBe('https://example.com/clip.mp4');
    expect(tasks[0]?.state).toBe('active');
    expect(second.fake.downloadItems.size).toBe(1);
  });

  it('keeps a cancelled job cancelled across a teardown', async () => {
    const store = createMemoryObjectStore();
    const first = boot(store);
    first.engine.setItems([mediaItem({ id: 'clip', url: 'https://example.com/clip.mp4' })]);
    await first.client.send('detection/run', report());
    await first.client.send('download/enqueue', { itemIds: ['clip'] });
    await flush();
    await first.client.send('download/cancel', { taskId: 'job-1' });
    await flush();
    await first.downloads.dispose();

    const second = boot(store);
    await second.downloads.ready();
    await flush();

    const tasks = await second.client.send('download/query', undefined);
    expect(tasks[0]?.state).toBe('canceled');
    // Nothing was restarted for a job the user cancelled.
    expect(second.fake.downloadItems.size).toBe(0);
  });

  it('refuses to download once the downloads permission is revoked', async () => {
    const store = createMemoryObjectStore();
    const { fake, engine, client, downloads } = boot(store);
    engine.setItems([mediaItem({ id: 'clip', url: 'https://example.com/clip.mp4' })]);
    await client.send('detection/run', report());

    fake.grantedPermissions.delete('downloads');
    await client.send('download/enqueue', { itemIds: ['clip'] });
    await flush();

    expect(fake.downloadItems.size).toBe(0);
    expect(downloads.snapshot().stats.total).toBe(0);
    expect(downloads.state.health().errors).toBe(1);
  });

  it('never enqueues protected media surfaced by detection', async () => {
    const store = createMemoryObjectStore();
    const { fake, engine, client, downloads } = boot(store);
    engine.setItems([
      mediaItem({
        id: 'drm',
        url: 'https://example.com/stream.m3u8',
        status: 'unsupported',
        unsupportedReason: 'Protected content',
      }),
    ]);
    await client.send('detection/run', report());

    await client.send('download/enqueue', { itemIds: ['drm'] });
    await flush();

    expect(fake.downloadItems.size).toBe(0);
    expect(downloads.snapshot().stats.failed).toBe(1);
  });
});
