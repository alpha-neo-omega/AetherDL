// @vitest-environment jsdom
/**
 * Performance: popup time-to-interactive (PROJECT_BIBLE.md §12.1 — the popup must
 * be interactive within 150 ms).
 *
 * The popup is mounted over the REAL background composition (real detection engine,
 * real download runtime, real message bus) on a real DOM, and the clock runs from
 * the moment the root renders until the media list is on screen with its actions
 * enabled — the point a user can actually click Download.
 */
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { createDetectionEngine } from '@core/detection/factory';
import { createBrowserFrom } from '@platform/browser/factory';
import { createMessageBus } from '@platform/messaging/service';
import { POPUP_TTI_BUDGET_MS } from '@shared/constants';
import type { DetectionReport, WireDomSignal } from '@shared/types';
import type { MediaPreferences } from '@ui/design-system';
import { PopupApp } from '@ui/popup';
import {
  createBackgroundDownloadRuntime,
  createDetectionItemResolver,
} from '@runtime/background/downloads';
import { createBackgroundRuntime } from '@runtime/background/runtime';
import { createPopupRuntimeClient } from '@runtime/popup/client';
import { createMemoryObjectStore } from '../unit/core/storage/_fixtures';
import { createFakeWebExt } from '../unit/platform/_fake-webext';
import { render } from '../unit/ui/_render';

const TAB = 11;
const RUNS = 10;
/**
 * Sanity ceiling for the very first mount in a worker, which also compiles React.
 * Generous on purpose: it catches a real regression without turning V8 warm-up
 * under a loaded CI runner into a budget failure.
 */
const COLD_MOUNT_CEILING_MS = 1000;
const NO_MEDIA_QUERIES: MediaPreferences = {
  matches: () => false,
  subscribe: () => () => undefined,
};

/** A page carrying a full popup's worth of media (the list the popup must paint). */
function report(count = 12): DetectionReport {
  const domSignals: WireDomSignal[] = [];
  for (let index = 0; index < count; index += 1) {
    domSignals.push({
      role: 'video',
      tagName: 'VIDEO',
      src: `https://cdn.example.com/clip-${String(index)}.mp4`,
      width: 1920,
      height: 1080,
      durationSec: 210,
    });
  }
  return { pageUrl: 'https://example.com/watch', domSignals, observedUrls: [] };
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
  const content = createMessageBus(fake.api);
  const client = createPopupRuntimeClient(browser);
  return {
    fake,
    content,
    client,
    async dispose(): Promise<void> {
      content.dispose();
      await downloads.dispose();
      await detection.dispose();
      browser.messaging.dispose();
    },
  };
}

/** Mount the popup and settle it, returning the elapsed time to interactive. */
async function measureOpen(client: ReturnType<typeof createPopupRuntimeClient>): Promise<{
  readonly ttiMs: number;
  readonly firstPaintMs: number;
  readonly cards: number;
  unmount(): void;
}> {
  const started = performance.now();
  const view = render(<PopupApp client={client} media={NO_MEDIA_QUERIES} locale="en-US" />);
  const firstPaintMs = performance.now() - started;

  // Settle the popup's asynchronous startup (active tab → detection query →
  // settings) the way the browser's event loop would.
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });

  const cards = view.container.querySelectorAll('.adl-card__title').length;
  const actions = view.container.querySelectorAll('.adl-card__actions .adl-button');
  const ttiMs = performance.now() - started;

  expect(cards).toBeGreaterThan(0);
  expect(actions.length).toBeGreaterThan(0);
  for (const action of actions) {
    expect((action as HTMLButtonElement).disabled).toBe(false);
  }

  return { ttiMs, firstPaintMs, cards, unmount: view.unmount };
}

/** UI frame budget: 60 fps means a data-driven update must commit in ≤ 16 ms (§12.1). */
const FRAME_BUDGET_MS = 16;

describe('popup time-to-interactive (§12.1)', () => {
  it('is interactive with a full media list within the 150 ms budget', async () => {
    const { content, client, dispose } = boot();
    await content.send('detection/run', report());

    // The first mount in a fresh worker also pays one-time V8 compilation of React
    // and the test harness — cost the reference environment pays at extension load,
    // not per popup open. It is reported and held to a coarse sanity ceiling; the
    // budget is asserted against the mounts that follow.
    const cold = await measureOpen(client);
    cold.unmount();

    const samples: number[] = [];
    const paints: number[] = [];
    let cards = 0;
    for (let run = 0; run < RUNS; run += 1) {
      const opened = await measureOpen(client);
      samples.push(opened.ttiMs);
      paints.push(opened.firstPaintMs);
      cards = opened.cards;
      opened.unmount();
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const worst = samples.reduce((max, value) => Math.max(max, value), 0);
    const worstPaint = paints.reduce((max, value) => Math.max(max, value), 0);
    console.log(
      `[perf] popup TTI: median ${median.toFixed(1)}ms, worst ${worst.toFixed(1)}ms ` +
        `over ${String(cards)} cards (first paint ${worstPaint.toFixed(1)}ms, ` +
        `cold mount ${cold.ttiMs.toFixed(1)}ms), budget ${String(POPUP_TTI_BUDGET_MS)}ms`,
    );

    // The suite owns the machine (vitest.perf.config.ts runs it single-fork), so
    // both the typical open and the worst one must fit the budget.
    expect(median).toBeLessThanOrEqual(POPUP_TTI_BUDGET_MS);
    expect(worst).toBeLessThanOrEqual(POPUP_TTI_BUDGET_MS);
    expect(cold.ttiMs).toBeLessThanOrEqual(COLD_MOUNT_CEILING_MS);
    await dispose();
  });

  it('paints its empty state immediately when a page has no media', async () => {
    const { client, dispose } = boot();

    const started = performance.now();
    const view = render(<PopupApp client={client} media={NO_MEDIA_QUERIES} locale="en-US" />);
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    const elapsed = performance.now() - started;

    expect(view.container.textContent).not.toBe('');
    expect(elapsed).toBeLessThanOrEqual(COLD_MOUNT_CEILING_MS);
    view.unmount();
    await dispose();
  });

  it('commits a pushed download update inside the 16 ms frame budget', async () => {
    const { content, client, dispose } = boot();
    await content.send('detection/run', report());
    const opened = await measureOpen(client);

    const samples: number[] = [];
    for (let tick = 0; tick < 60; tick += 1) {
      const started = performance.now();
      await act(async () => {
        await content.broadcast('download/event', {
          event: 'download:progress',
          task: {
            taskId: 'job-1',
            itemId: 'item-1',
            state: 'active',
            bytesReceived: tick * 1000,
            totalBytes: 60_000,
            progress: tick / 60,
            attempt: 0,
            filename: 'clip.mp4',
          },
        });
      });
      samples.push(performance.now() - started);
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    console.log(
      `[perf] popup update commit: median ${median.toFixed(2)}ms over 60 pushed events, ` +
        `budget ${String(FRAME_BUDGET_MS)}ms/frame`,
    );

    // A progress push arrives many times a second; if a single commit blew the frame
    // budget the popup would drop frames while a download runs (§12.1).
    expect(median).toBeLessThanOrEqual(FRAME_BUDGET_MS);
    opened.unmount();
    await dispose();
  });

  it('stays interactive on a pathological page with hundreds of items', async () => {
    const { content, client, dispose } = boot();
    const items = await content.send('detection/run', report(250));

    const started = performance.now();
    const view = render(<PopupApp client={client} media={NO_MEDIA_QUERIES} locale="en-US" />);
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    const elapsed = performance.now() - started;
    const cards = view.container.querySelectorAll('.adl-card__title').length;

    // Profiling evidence for the worst list the detection bounds allow. The popup
    // renders the list in full (no windowing), so this number scales with the item
    // count; it is reported rather than silently assumed to be small.
    console.log(
      `[perf] popup with ${String(items.length)} detected items: ${elapsed.toFixed(1)}ms ` +
        `to interactive, ${String(cards)} cards rendered`,
    );

    expect(cards).toBeGreaterThan(0);
    expect(elapsed).toBeLessThanOrEqual(COLD_MOUNT_CEILING_MS);
    view.unmount();
    await dispose();
  });

  it('leaks no DOM or subscription across repeated open/close cycles', async () => {
    const { fake, content, client, dispose } = boot();
    await content.send('detection/run', report());

    const listenersBefore = fake.onMessage.size;
    for (let run = 0; run < 25; run += 1) {
      const opened = await measureOpen(client);
      opened.unmount();
      // Opening and closing the popup adds no listener and leaves no node behind
      // (§12.7, §12.8).
      expect(fake.onMessage.size).toBe(listenersBefore);
      expect(document.body.childElementCount).toBe(0);
    }

    await dispose();
  });
});
