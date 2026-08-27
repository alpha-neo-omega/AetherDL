// @vitest-environment jsdom
/**
 * What one content-script observation costs, and how often it is paid
 * (PROJECT_BIBLE.md §12.1, §12.4, §12.9).
 *
 * The existing DOM-observation budget measures the scanner in isolation. It cannot see
 * the thing a user actually feels: the content script re-observes on every DOM
 * mutation, a video page mutates continuously, and each observation walks the document
 * more than once AND folds the whole resource timeline. Releases through 1.8.3 kept
 * adding to that hot path — frame origins, timeline accumulation, a rescan hook — with
 * nothing measuring the total.
 */
import { describe, expect, it } from 'vitest';
import { scanDocument, type DocumentLike } from '@runtime/content/scan';
import { createResourceTimeline, type TimelineEntry } from '@runtime/content/timeline';

/** How much of one core the scan may take while a page mutates continuously. */
const SCAN_DEBOUNCE_MS = 200;
const MAX_CORE_SHARE = 0.05;

/** A watch page's real weight: chrome, comments, recommendations, ads. */
function watchPage(elements = 4000): Document {
  const parts: string[] = [];
  for (let index = 0; index < elements; index += 1) {
    parts.push(
      index % 50 === 0 ? `<a href="/thing-${String(index)}">t</a>` : `<div class="row">x</div>`,
    );
  }
  parts.push('<video src="blob:https://site.test/abc"></video>');
  parts.push('<iframe src="https://player.test/e/abc"></iframe>');
  document.body.innerHTML = parts.join('');
  return document;
}

/** A frozen timeline: the playlist, then the segments that filled the buffer. */
function timelineEntries(count = 250): readonly TimelineEntry[] {
  const entries: TimelineEntry[] = [
    { name: 'https://cdn.test/hls/index.txt', initiatorType: 'fetch', transferSize: 2048 },
  ];
  for (let index = 0; index < count; index += 1) {
    entries.push({
      name: `https://cdn.test/seg-${String(index)}.css`,
      initiatorType: 'fetch',
      transferSize: 500_000,
    });
  }
  return entries;
}

/** Everything one observation does, as the entry module composes it. */
function observe(
  doc: Document,
  timeline: ReturnType<typeof createResourceTimeline>,
  entries: readonly TimelineEntry[],
): void {
  scanDocument(doc as unknown as DocumentLike);
  doc.querySelectorAll('iframe, frame').length;
  for (const frame of doc.querySelectorAll('iframe, frame')) {
    frame.getAttribute('src');
  }
  timeline.harvest(entries);
}

function millisPer(rounds: number, run: () => void): number {
  run();
  const started = performance.now();
  for (let round = 0; round < rounds; round += 1) {
    run();
  }
  return (performance.now() - started) / rounds;
}

describe('content script: the cost of observing a page that keeps changing', () => {
  it('costs a small enough share of a core to be paid every debounce interval', () => {
    const doc = watchPage();
    const timeline = createResourceTimeline();
    const entries = timelineEntries();

    const perObservation = millisPer(60, () => {
      observe(doc, timeline, entries);
    });

    // A page that mutates continuously pays this every SCAN_DEBOUNCE_MS, in the page's
    // own main thread, next to the video that is decoding.
    const coreShare = perObservation / SCAN_DEBOUNCE_MS;
    expect(
      coreShare,
      `one observation took ${perObservation.toFixed(2)}ms = ${(coreShare * 100).toFixed(1)}% of a core at one per ${String(SCAN_DEBOUNCE_MS)}ms`,
    ).toBeLessThan(MAX_CORE_SHARE);
  });

  it('does not get slower the longer a page is watched', () => {
    // The timeline is accumulated, so a long session must not turn each observation
    // into a walk over an ever-growing set (§10.9).
    const doc = watchPage();
    const timeline = createResourceTimeline();
    const entries = timelineEntries();

    const early = millisPer(40, () => {
      observe(doc, timeline, entries);
    });
    for (let round = 0; round < 400; round += 1) {
      timeline.harvest(entries);
    }
    const late = millisPer(40, () => {
      observe(doc, timeline, entries);
    });

    expect(late, `early ${early.toFixed(2)}ms vs late ${late.toFixed(2)}ms`).toBeLessThan(
      early * 2 + 0.5,
    );
  });
});
