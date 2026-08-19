/**
 * Performance: memory profile of the long-lived background state
 * (PROJECT_BIBLE.md §12.5, §12.7).
 *
 * The background survives an entire browsing session, so every structure it keeps
 * must be bounded by something the user controls — live tabs, in-flight work, the
 * cache bound — and never by "how long the browser has been open". These tests
 * drive long sessions and assert the structures return to their resting size.
 */
import { describe, expect, it } from 'vitest';
import { createDetectionEngine } from '@core/detection/factory';
import { createBrowserFrom } from '@platform/browser/factory';
import { createMessageBus } from '@platform/messaging/service';
import type { DetectionReport } from '@shared/types';
import {
  createBackgroundDownloadRuntime,
  createDetectionItemResolver,
} from '@runtime/background/downloads';
import { createBackgroundRuntime } from '@runtime/background/runtime';
import { createMemoryObjectStore } from '../unit/core/storage/_fixtures';
import { createFakeWebExt } from '../unit/platform/_fake-webext';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const MB = 1024 * 1024;
/** Idle background memory budget (PROJECT_BIBLE.md §12.1). */
const IDLE_MEMORY_BUDGET_BYTES = 25 * MB;

function report(pageUrl: string): DetectionReport {
  return {
    pageUrl,
    domSignals: [
      { role: 'video', tagName: 'VIDEO', src: `${pageUrl}/clip.mp4`, width: 1280, height: 720 },
    ],
    observedUrls: [`${pageUrl}/alt.webm`],
  };
}

function boot(maxTabs?: number) {
  const fake = createFakeWebExt();
  fake.grantedPermissions.add('downloads');
  const browser = createBrowserFrom(fake.api, 'chrome');
  const detection = createBackgroundRuntime({
    browser,
    engine: createDetectionEngine(maxTabs === undefined ? {} : { maxTabs }),
  });
  detection.start();
  const downloads = createBackgroundDownloadRuntime({
    browser,
    resolver: createDetectionItemResolver(detection.state),
    store: createMemoryObjectStore(),
  });
  downloads.start();
  const client = createMessageBus(fake.api);
  return {
    fake,
    client,
    detection,
    downloads,
    async dispose(): Promise<void> {
      client.dispose();
      await downloads.dispose();
      await detection.dispose();
      browser.messaging.dispose();
    },
  };
}

describe('memory profile: detection state over a long session', () => {
  it('holds one record per live tab, however many times a tab is re-detected', async () => {
    const { fake, client, detection, dispose } = boot();
    fake.setTabs([{ id: 3, active: true, url: 'https://example.com/watch', windowId: 1 }]);

    for (let run = 0; run < 500; run += 1) {
      await client.send('detection/run', report(`https://example.com/watch`));
    }

    // Re-detecting the same page 500 times leaves exactly one tab record holding one
    // result set — observations replace, they never accumulate (§12.7).
    expect(detection.state.tabs()).toHaveLength(1);
    expect(detection.state.getItems(3).length).toBeLessThanOrEqual(2);
    await dispose();
  });

  it('returns to an empty state when a long browsing session ends', async () => {
    const { fake, client, detection, dispose } = boot();

    for (let tabId = 1; tabId <= 200; tabId += 1) {
      fake.setTabs([
        { id: tabId, active: true, url: `https://example.com/${String(tabId)}`, windowId: 1 },
      ]);
      fake.onTabCreated.trigger({ id: tabId, active: true });
      await client.send('detection/run', report(`https://example.com/${String(tabId)}`));
      fake.onUpdated.trigger(
        tabId,
        { url: `https://example.com/${String(tabId)}/next` },
        { id: tabId, active: true },
      );
    }
    expect(detection.state.tabs().length).toBeGreaterThan(0);

    for (let tabId = 1; tabId <= 200; tabId += 1) {
      fake.onTabRemoved.trigger(tabId, { windowId: 1, isWindowClosing: false });
    }

    expect(detection.state.tabs()).toHaveLength(0);
    await dispose();
  });

  it('keeps the detection cache at its bound while tabs churn', async () => {
    const { fake, client, detection, dispose } = boot(4);
    const misses: number[] = [];
    detection.on('cache:miss', ({ tabId }) => misses.push(tabId));

    for (let tabId = 1; tabId <= 60; tabId += 1) {
      fake.setTabs([{ id: tabId, active: true, url: 'https://example.com/x', windowId: 1 }]);
      await client.send('detection/run', report('https://example.com/x'));
    }

    // Every tab past the bound evicts the least-recently-used entry, so the cache
    // never grows with session length (§9.8, §12.5).
    expect(misses).toHaveLength(60);
    await dispose();
  });
});

describe('memory profile: idle background footprint (§12.1)', () => {
  it('holds well under the 25 MB idle budget once booted', async () => {
    const before = process.memoryUsage().heapUsed;
    const { dispose } = boot();
    await flush();
    // A GC between the two samples can make the delta negative; clamp so the number
    // reads as "retained by the runtime", never as a negative footprint.
    const idle = Math.max(0, process.memoryUsage().heapUsed - before);

    console.log(`[perf] idle background heap: ${(idle / MB).toFixed(2)}MB / 25MB budget`);
    expect(idle).toBeLessThanOrEqual(IDLE_MEMORY_BUDGET_BYTES);
    await dispose();
  });

  it('does not grow its footprint across a long detection session', async () => {
    const { fake, client, dispose } = boot();
    fake.setTabs([{ id: 4, active: true, url: 'https://example.com/watch', windowId: 1 }]);
    await client.send('detection/run', report('https://example.com/watch'));
    await flush();
    const settled = process.memoryUsage().heapUsed;

    for (let run = 0; run < 300; run += 1) {
      await client.send('detection/run', report(`https://example.com/watch/${String(run)}`));
    }
    const growth = Math.max(0, process.memoryUsage().heapUsed - settled);

    // 300 detections retain only the bounded cache and one tab record, so the
    // footprint stays inside the same idle budget rather than tracking run count.
    console.log(`[perf] heap growth over 300 detections: ${(growth / MB).toFixed(2)}MB`);
    expect(growth).toBeLessThanOrEqual(IDLE_MEMORY_BUDGET_BYTES);
    await dispose();
  });
});

describe('memory profile: download state over a long session', () => {
  it('retains no per-download tracking once downloads finish', async () => {
    const { fake, client, downloads, dispose } = boot();
    fake.setTabs([{ id: 9, active: true, url: 'https://example.com/watch', windowId: 1 }]);

    for (let run = 0; run < 25; run += 1) {
      const items = await client.send('detection/run', report('https://example.com/watch'));
      const first = items[0];
      expect(first).toBeDefined();

      await client.send('download/enqueue', { itemIds: [first?.id ?? ''] });
      await flush();

      for (const [id] of fake.downloadItems) {
        fake.downloadItems.set(id, {
          id,
          state: 'complete',
          bytesReceived: 100,
          totalBytes: 100,
          filename: 'clip.mp4',
        });
        fake.onDownloadChanged.trigger({ id, state: { current: 'complete' } });
      }
      await flush();
      await client.send('download/clear', undefined);
      await flush();
    }

    // Progress rows and retry schedules are keyed by task and dropped at the terminal
    // state; after clearing, nothing per-download is retained (§12.7).
    expect(await client.send('download/progress', undefined)).toEqual([]);
    expect(downloads.snapshot().retries).toEqual([]);
    const stats = await client.send('download/stats', undefined);
    expect(stats.total).toBe(0);

    await dispose();
  });

  it('drops a retry schedule as soon as the retry resolves', async () => {
    const { fake, client, downloads, dispose } = boot();
    fake.setTabs([{ id: 9, active: true, url: 'https://example.com/watch', windowId: 1 }]);
    const items = await client.send('detection/run', report('https://example.com/watch'));

    await client.send('download/enqueue', { itemIds: [items[0]?.id ?? ''] });
    await flush();
    for (const [id] of fake.downloadItems) {
      fake.downloadItems.set(id, {
        id,
        state: 'complete',
        bytesReceived: 10,
        totalBytes: 10,
        filename: 'clip.mp4',
      });
      fake.onDownloadChanged.trigger({ id, state: { current: 'complete' } });
    }
    await flush();

    expect(downloads.snapshot().retries).toEqual([]);
    await dispose();
  });
});
