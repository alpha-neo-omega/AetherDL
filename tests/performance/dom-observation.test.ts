/**
 * Performance: DOM observation stays bounded and cheap (PROJECT_BIBLE.md §12.4,
 *              §9.10, §8.10).
 *
 * The content script runs on every page the user visits, so its observation must be
 * debounced, bounded, and fully detachable. This suite holds it to all three.
 */
import { describe, expect, it, vi } from 'vitest';
import { MAX_DOM_SIGNALS, MAX_OBSERVED_URLS } from '@shared/constants';
import { MAX_SIGNALS, MAX_URLS, buildDetectionContext } from '@runtime/background/context';
import { createContentObserver } from '@runtime/content/observer';
import { scanDocument, type DocumentLike, type MediaElementLike } from '@runtime/content/scan';
import type { DetectionReport } from '@shared/types';

function video(index: number): MediaElementLike {
  return {
    tagName: 'VIDEO',
    getAttribute: () => null,
    currentSrc: `https://cdn.example.com/clip-${index}.mp4`,
  };
}

/** A document that counts how many elements the scanner actually pulls. */
function countingDocument(total: number): { readonly document: DocumentLike; visited(): number } {
  let visited = 0;
  return {
    document: {
      querySelectorAll: function* (): Generator<MediaElementLike> {
        for (let index = 0; index < total; index += 1) {
          visited += 1;
          yield video(index);
        }
      },
    },
    visited: () => visited,
  };
}

describe('DOM observation: bounded scanning', () => {
  it('caps the signals a single observation carries', () => {
    const { document } = countingDocument(MAX_DOM_SIGNALS * 3);
    const result = scanDocument(document);
    expect(result.domSignals).toHaveLength(MAX_DOM_SIGNALS);
  });

  it('caps the observed URLs a single observation carries', () => {
    const { document } = countingDocument(MAX_OBSERVED_URLS * 3);
    const result = scanDocument(document);
    expect(result.observedUrls.length).toBeLessThanOrEqual(MAX_OBSERVED_URLS);
  });

  it('stops walking a pathological DOM instead of visiting every node', () => {
    const pathological = countingDocument(50_000);
    scanDocument(pathological.document);
    // The walk stops once both bounds are met, so the cost is bounded by the caps,
    // not by the page's node count (§9.10).
    expect(pathological.visited()).toBeLessThanOrEqual(MAX_DOM_SIGNALS + 1);
  });

  it('scans a normal page in full', () => {
    const { document, visited } = countingDocument(12);
    const result = scanDocument(document);
    expect(result.domSignals).toHaveLength(12);
    expect(visited()).toBe(12);
  });

  it('bounds the scan with exactly the number the background enforces', () => {
    // One bound, shared by the source and the trust boundary — a report can never
    // be built larger than it will be accepted (§13.8).
    expect(MAX_SIGNALS).toBe(MAX_DOM_SIGNALS);
    expect(MAX_URLS).toBe(MAX_OBSERVED_URLS);
  });

  it('leaves the background boundary cap intact for an untrusted report', () => {
    const report: DetectionReport = {
      pageUrl: 'https://example.com',
      domSignals: Array.from({ length: MAX_DOM_SIGNALS * 2 }, () => ({
        role: 'video' as const,
        tagName: 'VIDEO',
        src: 'https://cdn.example.com/x.mp4',
      })),
      observedUrls: Array.from({ length: MAX_OBSERVED_URLS * 2 }, (_, i) => `https://x.test/${i}`),
    };

    const context = buildDetectionContext(report, 1, 'dom', 0);

    expect(context.domSignals).toHaveLength(MAX_SIGNALS);
    expect(context.observedUrls).toHaveLength(MAX_URLS);
  });
});

describe('DOM observation: debounced reporting', () => {
  function harness() {
    const reports: DetectionReport[] = [];
    let pending: (() => void) | undefined;
    let scheduled = 0;
    let cancelled = 0;
    const observer = createContentObserver({
      document: { querySelectorAll: () => [video(0)] },
      pageUrl: () => 'https://example.com/watch',
      sendReport: (report) => reports.push(report),
      scheduleScan: (run) => {
        scheduled += 1;
        pending = run;
        return () => {
          cancelled += 1;
          pending = undefined;
        };
      },
    });
    return {
      observer,
      reports,
      counts: () => ({ scheduled, cancelled }),
      fire: () => {
        const run = pending;
        pending = undefined;
        run?.();
      },
      hasPending: () => pending !== undefined,
    };
  }

  it('coalesces a mutation storm into one report', () => {
    const h = harness();
    for (let index = 0; index < 500; index += 1) {
      h.observer.notify();
    }
    expect(h.reports).toHaveLength(0);

    h.fire();

    expect(h.reports).toHaveLength(1);
    // Every notify but the first cancelled the prior pending scan (§12.4).
    expect(h.counts().cancelled).toBe(499);
  });

  it('does no scanning work until the debounce fires', () => {
    const scan = vi.fn(() => [video(0)]);
    const observer = createContentObserver({
      document: { querySelectorAll: scan },
      pageUrl: () => 'https://example.com',
      sendReport: () => undefined,
      scheduleScan: () => () => undefined,
    });

    observer.notify();
    observer.notify();

    expect(scan).not.toHaveBeenCalled();
    observer.dispose();
  });

  it('cancels the pending scan on teardown, leaving nothing scheduled', () => {
    const h = harness();
    h.observer.notify();
    expect(h.hasPending()).toBe(true);

    h.observer.dispose();

    expect(h.hasPending()).toBe(false);
    expect(h.counts().cancelled).toBe(1);
    h.fire();
    expect(h.reports).toHaveLength(0);
  });

  it('flush reports once and clears the pending scan', () => {
    const h = harness();
    h.observer.notify();
    h.observer.flush();

    expect(h.reports).toHaveLength(1);
    expect(h.hasPending()).toBe(false);
  });
});
