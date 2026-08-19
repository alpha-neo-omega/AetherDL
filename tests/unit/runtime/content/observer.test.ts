import { describe, expect, it, vi } from 'vitest';
import { createContentObserver } from '@runtime/content/observer';
import type { DocumentLike, MediaElementLike } from '@runtime/content/scan';
import type { DetectionReport } from '@shared/types';

function docWith(currentSrc: string): DocumentLike {
  const el: MediaElementLike = {
    tagName: 'VIDEO',
    getAttribute: () => null,
    currentSrc,
  };
  return { querySelectorAll: () => [el] };
}

/** Manual scheduler: captures the pending run so tests can fire or cancel it. */
function manualScheduler() {
  const runs: Array<() => void> = [];
  let canceled = 0;
  return {
    schedule: (run: () => void): (() => void) => {
      runs.push(run);
      return () => {
        canceled += 1;
      };
    },
    fireLast: (): void => {
      runs[runs.length - 1]?.();
    },
    get scheduled(): number {
      return runs.length;
    },
    get canceled(): number {
      return canceled;
    },
  };
}

describe('content observer', () => {
  it('debounces: notify schedules, and the report is built on fire', () => {
    const scheduler = manualScheduler();
    const reports: DetectionReport[] = [];
    const observer = createContentObserver({
      document: docWith('https://x.com/a.mp4'),
      pageUrl: () => 'https://x.com/watch',
      documentTitle: () => 'Watch',
      sendReport: (report) => reports.push(report),
      scheduleScan: scheduler.schedule,
    });

    observer.notify();
    expect(scheduler.scheduled).toBe(1);
    expect(reports).toHaveLength(0); // nothing sent until the debounce fires

    scheduler.fireLast();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      pageUrl: 'https://x.com/watch',
      documentTitle: 'Watch',
    });
    expect(reports[0]?.observedUrls).toContain('https://x.com/a.mp4');
  });

  it('coalesces rapid notifies by cancelling the prior pending scan', () => {
    const scheduler = manualScheduler();
    const observer = createContentObserver({
      document: docWith('https://x.com/a.mp4'),
      pageUrl: () => 'https://x.com',
      sendReport: vi.fn(),
      scheduleScan: scheduler.schedule,
    });
    observer.notify();
    observer.notify();
    observer.notify();
    expect(scheduler.scheduled).toBe(3);
    expect(scheduler.canceled).toBe(2); // each new notify cancels the previous
  });

  it('flush reports immediately and omits an empty title', () => {
    const scheduler = manualScheduler();
    const reports: DetectionReport[] = [];
    const observer = createContentObserver({
      document: docWith('https://x.com/a.mp4'),
      pageUrl: () => 'https://x.com',
      documentTitle: () => '',
      frameId: 3,
      sendReport: (report) => reports.push(report),
      scheduleScan: scheduler.schedule,
    });
    observer.flush();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.frameId).toBe(3);
    expect(reports[0]).not.toHaveProperty('documentTitle');
  });

  it('dispose cancels a pending scan', () => {
    const scheduler = manualScheduler();
    const observer = createContentObserver({
      document: docWith('https://x.com/a.mp4'),
      pageUrl: () => 'https://x.com',
      sendReport: vi.fn(),
      scheduleScan: scheduler.schedule,
    });
    observer.notify();
    observer.dispose();
    expect(scheduler.canceled).toBe(1);
  });
});
