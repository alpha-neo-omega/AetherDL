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
  const delays: number[] = [];
  let canceled = 0;
  return {
    schedule: (run: () => void, delayMs = 0): (() => void) => {
      runs.push(run);
      delays.push(delayMs);
      return () => {
        canceled += 1;
      };
    },
    get delays(): readonly number[] {
      return delays;
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

  it('reports the cross-origin origins the page embeds, and omits an empty list', () => {
    // The background cannot enter a frame belonging to someone else, so the origin is
    // reported for the user to decide about (§13.7).
    const reports: DetectionReport[] = [];
    const observer = createContentObserver({
      document: docWith('https://x.com/a.mp4'),
      pageUrl: () => 'https://x.com',
      frameOrigins: () => ['https://player.test'],
      frameCount: () => 1,
      sendReport: (report) => reports.push(report),
      scheduleScan: manualScheduler().schedule,
    });
    observer.flush();
    expect(reports[0]?.frameOrigins).toEqual(['https://player.test']);

    const bare: DetectionReport[] = [];
    const plain = createContentObserver({
      document: docWith('https://x.com/a.mp4'),
      pageUrl: () => 'https://x.com',
      frameOrigins: () => [],
      sendReport: (report) => bare.push(report),
      scheduleScan: manualScheduler().schedule,
    });
    plain.flush();
    expect(bare[0]).not.toHaveProperty('frameOrigins');
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

describe('content observer: what a page that keeps moving costs (§12.1, §12.4)', () => {
  /** Drive one debounced scan. */
  const tick = (
    observer: ReturnType<typeof createContentObserver>,
    scheduler: ReturnType<typeof manualScheduler>,
  ): void => {
    observer.notify();
    scheduler.fireLast();
  };

  it('does not report the same observation twice', () => {
    // A playing video mutates several times a second and says nothing new each time.
    // Every one of those used to be a cross-process message carrying hundreds of
    // observations, and two detection passes in the background.
    const scheduler = manualScheduler();
    const reports: DetectionReport[] = [];
    const observer = createContentObserver({
      document: docWith('https://x.com/a.mp4'),
      pageUrl: () => 'https://x.com/watch',
      sendReport: (report) => reports.push(report),
      scheduleScan: scheduler.schedule,
    });

    for (let mutation = 0; mutation < 20; mutation += 1) {
      tick(observer, scheduler);
    }

    expect(reports).toHaveLength(1);
  });

  it('reports again the moment the page really changes', () => {
    const scheduler = manualScheduler();
    const reports: DetectionReport[] = [];
    let src = 'https://x.com/a.mp4';
    const observer = createContentObserver({
      document: {
        querySelectorAll: () => [
          { tagName: 'VIDEO', getAttribute: (name: string) => (name === 'src' ? src : null) },
        ],
      } as never,
      pageUrl: () => 'https://x.com/watch',
      sendReport: (report) => reports.push(report),
      scheduleScan: scheduler.schedule,
    });

    tick(observer, scheduler);
    tick(observer, scheduler);
    expect(reports).toHaveLength(1);

    src = 'https://x.com/b.mp4';
    tick(observer, scheduler);

    expect(reports).toHaveLength(2);
    expect(reports[1]?.domSignals[0]?.src).toBe('https://x.com/b.mp4');
  });

  it('scans less often the longer nothing changes, and picks up again when it does', () => {
    const scheduler = manualScheduler();
    let src = 'https://x.com/a.mp4';
    const observer = createContentObserver({
      document: {
        querySelectorAll: () => [
          { tagName: 'VIDEO', getAttribute: (name: string) => (name === 'src' ? src : null) },
        ],
      } as never,
      pageUrl: () => 'https://x.com/watch',
      sendReport: () => undefined,
      scheduleScan: scheduler.schedule,
      intervalMs: 200,
      maxIntervalMs: 2000,
    });

    for (let mutation = 0; mutation < 6; mutation += 1) {
      tick(observer, scheduler);
    }
    const backedOff = scheduler.delays[scheduler.delays.length - 1] ?? 0;
    expect(backedOff).toBeGreaterThan(200);
    expect(backedOff).toBeLessThanOrEqual(2000);

    src = 'https://x.com/b.mp4';
    tick(observer, scheduler);
    observer.notify();

    // A real change puts it back on the short interval: responsiveness is only traded
    // away while there is demonstrably nothing to say.
    expect(scheduler.delays[scheduler.delays.length - 1]).toBe(200);
  });

  it('reports on flush even when nothing changed', () => {
    // The background asks for this when its own state is gone (a suspended service
    // worker): "nothing changed since I last told you" is not an answer it can use.
    const scheduler = manualScheduler();
    const reports: DetectionReport[] = [];
    const observer = createContentObserver({
      document: docWith('https://x.com/a.mp4'),
      pageUrl: () => 'https://x.com/watch',
      sendReport: (report) => reports.push(report),
      scheduleScan: scheduler.schedule,
    });

    tick(observer, scheduler);
    observer.flush();
    observer.flush();

    expect(reports).toHaveLength(3);
  });
});
