/**
 * Performance: the latency budgets in PROJECT_BIBLE.md §12.1.
 *
 * Detection must finish inside 300 ms and a download must start inside 200 ms.
 * Both are measured over the REAL composition (real engine, real detectors, real
 * message bus, real download manager) against a fake WebExtension namespace, so
 * what is timed is AetherDL's own work rather than a stub's.
 */
import { describe, expect, it } from 'vitest';
import { createDetectionEngine } from '@core/detection/factory';
import { createBrowserFrom } from '@platform/browser/factory';
import { createMessageBus } from '@platform/messaging/service';
import { DETECTION_LATENCY_BUDGET_MS } from '@shared/constants';
import type { DetectionReport, WireDomSignal } from '@shared/types';
import {
  createBackgroundDownloadRuntime,
  createDetectionItemResolver,
} from '@runtime/background/downloads';
import { createBackgroundRuntime } from '@runtime/background/runtime';
import { createMemoryObjectStore } from '../unit/core/storage/_fixtures';
import { createFakeWebExt } from '../unit/platform/_fake-webext';

/** Download-start budget in milliseconds (PROJECT_BIBLE.md §12.1). */
const DOWNLOAD_START_BUDGET_MS = 200;

/** Repetitions timed per measurement; the WORST run is what must fit the budget. */
const RUNS = 20;

const TAB = 5;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A media-heavy page: a gallery of progressive videos plus a HLS manifest. */
function heavyReport(pageUrl: string): DetectionReport {
  const domSignals: WireDomSignal[] = [];
  for (let index = 0; index < 60; index += 1) {
    domSignals.push({
      role: index % 3 === 0 ? 'audio' : 'video',
      tagName: index % 3 === 0 ? 'AUDIO' : 'VIDEO',
      src: `https://cdn.example.com/media-${String(index)}.${index % 3 === 0 ? 'mp3' : 'mp4'}`,
      width: 1920,
      height: 1080,
      durationSec: 300,
    });
  }
  const observedUrls = [
    'https://cdn.example.com/stream/master.m3u8',
    ...Array.from({ length: 60 }, (_, i) => `https://cdn.example.com/extra-${String(i)}.webm`),
  ];
  return { pageUrl, domSignals, observedUrls };
}

async function timeAsync(run: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await run();
  return performance.now() - started;
}

function worst(samples: readonly number[]): number {
  return samples.reduce((max, value) => Math.max(max, value), 0);
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function boot() {
  const fake = createFakeWebExt();
  fake.grantedPermissions.add('downloads');
  fake.setTabs([{ id: TAB, active: true, url: 'https://example.com/watch', windowId: 1 }]);
  const browser = createBrowserFrom(fake.api, 'chrome');
  const detection = createBackgroundRuntime({ browser, engine: createDetectionEngine({}) });
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

describe('latency budgets (§12.1)', () => {
  it('completes detection on a media-heavy page within the 300 ms budget', async () => {
    const { client, dispose } = boot();
    const samples: number[] = [];

    for (let run = 0; run < RUNS; run += 1) {
      // A distinct URL per run so the cache never answers — every sample times the
      // full pipeline, not a cache hit (§9.8).
      const report = heavyReport(`https://example.com/watch/${String(run)}`);
      let items: readonly unknown[] = [];
      samples.push(
        await timeAsync(async () => {
          items = await client.send('detection/run', report);
        }),
      );
      expect(items.length).toBeGreaterThan(0);
    }

    console.log(
      `[perf] detection: worst ${worst(samples).toFixed(1)}ms, ` +
        `median ${median(samples).toFixed(1)}ms, budget ${String(DETECTION_LATENCY_BUDGET_MS)}ms`,
    );
    expect(worst(samples)).toBeLessThanOrEqual(DETECTION_LATENCY_BUDGET_MS);
    await dispose();
  });

  it('answers a cached detection query far inside the budget', async () => {
    const { client, dispose } = boot();
    await client.send('detection/run', heavyReport('https://example.com/watch'));

    const samples: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      samples.push(await timeAsync(() => client.send('detection/query', { tabId: TAB })));
    }

    console.log(`[perf] detection/query: worst ${worst(samples).toFixed(1)}ms`);
    expect(worst(samples)).toBeLessThanOrEqual(DETECTION_LATENCY_BUDGET_MS);
    await dispose();
  });

  it('starts a download within the 200 ms budget', async () => {
    const samples: number[] = [];

    for (let run = 0; run < RUNS; run += 1) {
      const { fake, client, dispose } = boot();
      const items = await client.send('detection/run', heavyReport('https://example.com/watch'));
      const first = items[0];
      expect(first).toBeDefined();

      const elapsed = await timeAsync(async () => {
        await client.send('download/enqueue', { itemIds: [first?.id ?? ''] });
        // The browser download is handed off asynchronously; the budget covers the
        // whole path from the popup's click to the native download existing (§12.1).
        while (fake.downloadItems.size === 0) {
          await flush();
        }
      });
      samples.push(elapsed);
      expect(fake.downloadItems.size).toBe(1);
      await dispose();
    }

    console.log(
      `[perf] download start: worst ${worst(samples).toFixed(1)}ms, ` +
        `median ${median(samples).toFixed(1)}ms, budget ${String(DOWNLOAD_START_BUDGET_MS)}ms`,
    );
    expect(worst(samples)).toBeLessThanOrEqual(DOWNLOAD_START_BUDGET_MS);
  });
});
