/**
 * What a page that is merely PLAYING costs the extension (PROJECT_BIBLE.md §12.1,
 * §12.4).
 *
 * The budgets already here measure one detection pass. They cannot see the cost a user
 * actually feels, which is the pass being run again and again: the content script
 * re-reports on every DOM mutation, a playing video mutates several times a second — a
 * ticking time display is a childList mutation — and every report drove the full
 * pipeline twice, once for the DOM and once after the probe. Detection is 7 ms median
 * and 36 ms worst on a media-heavy page, so that is real CPU spent next to a decoding
 * video, on results that cannot have changed.
 *
 * These budgets are about REPEATED work, so they count pipeline runs rather than
 * milliseconds: a wall-clock number here would measure the machine, and the defect is
 * not that one pass is slow.
 */
import { describe, expect, it } from 'vitest';
import { createBrowserFrom } from '@platform/browser/factory';
import { createMessageBus } from '@platform/messaging/service';
import { createBackgroundRuntime } from '@runtime/background/runtime';
import type { DetectionReport, WireDomSignal } from '@shared/types';
import type { NetworkResource } from '@core/detection/pipeline';
import type { ResourceProbe } from '@core/detection/probe';
import { createFakeEngine, mediaItem } from '../unit/runtime/_fixtures';
import { createFakeWebExt } from '../unit/platform/_fake-webext';

const TAB = 7;
const PAGE = 'https://site.test/watch';
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A watch page's observations: some media, and a timeline the player keeps adding to. */
function playingReport(): DetectionReport {
  const domSignals: WireDomSignal[] = [
    { role: 'video', tagName: 'VIDEO', src: 'blob:https://site.test/abc' },
  ];
  return {
    pageUrl: PAGE,
    documentTitle: 'Watch',
    domSignals,
    observedUrls: [],
    observedResources: Array.from({ length: 40 }, (_, index) => ({
      url: `https://cdn.test/seg-${String(index)}.css`,
      initiatorType: 'fetch',
    })),
  };
}

/** A probe that has already identified the stream, as one has after the first pass. */
function settledProbe(): ResourceProbe {
  const identified: readonly NetworkResource[] = [
    { url: 'https://cdn.test/hls/index.txt', mimeType: 'application/vnd.apple.mpegurl' },
  ];
  return {
    identify: () => Promise.resolve(identified),
    forget: () => undefined,
  };
}

function boot() {
  const fake = createFakeWebExt();
  fake.setTabs([{ id: TAB, active: true, url: PAGE, windowId: 1 }]);
  const browser = createBrowserFrom(fake.api, 'chrome');
  const engine = createFakeEngine();
  engine.setItems([mediaItem({ id: 'stream', kind: 'stream' })]);
  const runtime = createBackgroundRuntime({
    browser,
    engine: engine.manager,
    clock: () => 1000,
    probe: settledProbe(),
  });
  runtime.start();
  return { fake, engine, runtime, client: createMessageBus(fake.api) };
}

describe('a page that is only playing (§12.1)', () => {
  it('does not re-run the pipeline for a report that says the same thing', async () => {
    const { client, engine } = boot();
    const report = playingReport();

    await client.send('detection/run', report);
    await flush();
    const afterFirst = engine.contexts.length;

    // Thirty more mutations, thirty more identical reports — five seconds of a video
    // playing with nothing else happening.
    for (let mutation = 0; mutation < 30; mutation += 1) {
      await client.send('detection/run', report);
    }
    await flush();

    const extra = engine.contexts.length - afterFirst;
    expect(
      extra,
      `${String(extra)} extra pipeline runs for 30 identical reports (was 60 before this budget existed)`,
    ).toBe(0);
  });

  it('still runs the pipeline the moment the page really changes', async () => {
    const { client, engine } = boot();

    await client.send('detection/run', playingReport());
    await flush();
    const settled = engine.contexts.length;

    // The player swaps in a second video: a genuine change, and it must be detected.
    await client.send('detection/run', {
      ...playingReport(),
      domSignals: [
        { role: 'video', tagName: 'VIDEO', src: 'blob:https://site.test/abc' },
        { role: 'video', tagName: 'VIDEO', src: 'https://cdn.test/second.mp4' },
      ],
    });
    await flush();

    expect(engine.contexts.length).toBeGreaterThan(settled);
  });

  it('still answers a manual refresh in full, however unchanged the page is', async () => {
    // The user asking is not the page mutating: a refresh re-runs regardless (§4.1).
    const { client, engine } = boot();

    await client.send('detection/run', playingReport());
    await flush();
    const settled = engine.contexts.length;

    await client.send('detection/refresh', { tabId: TAB });
    await flush();

    expect(engine.contexts.length).toBeGreaterThan(settled);
  });
});
