/**
 * Module: runtime/content/observer
 * Purpose: Coordinate the content script's observe→collect→report loop
 *          (PROJECT_BIBLE.md §8.10). Debounces scans (performance budget, §12) and
 *          reports a `DetectionReport` to the background. Detection is NOT performed
 *          here; the report is the only output.
 *
 *          Two rules keep a playing video from costing anything: an observation that
 *          says exactly what the last one said is not SENT, and a page that keeps
 *          changing without changing anything relevant is scanned progressively less
 *          often. A video page mutates several times a second for as long as it plays
 *          — a ticking time display is a childList mutation — and every one of those
 *          used to cost a full scan, a cross-process message carrying up to several
 *          hundred observations, and two detection passes in the background (§12.1,
 *          §12.4).
 * Restrictions: Runtime layer, isolated world. Pure of browser globals — the DOM
 *          event sources and messaging are injected by the entry (index.ts).
 * Public API: ContentObserver, ContentObserverDeps, createContentObserver.
 */
import type { DetectionReport, WireObservedResource } from '@shared/types';
import type { DocumentLike } from '@runtime/content/scan';
import { scanDocument } from '@runtime/content/scan';

export interface ContentObserver {
  /** Schedule a debounced scan + report. Call on readiness/mutation/media events. */
  notify(): void;
  /**
   * Scan + report immediately, cancelling any pending debounce, and report even if
   * nothing has changed. That last part is the point: the background asks for this
   * when its own state is gone (a suspended service worker), so "nothing changed
   * since I last told you" is not an answer it can use.
   */
  flush(): void;
  /** Cancel any pending scan (call on unload alongside detaching DOM sources). */
  dispose(): void;
}

export interface ContentObserverDeps {
  readonly document: DocumentLike;
  /** Current page URL (e.g. `location.href`). */
  readonly pageUrl: () => string;
  /** Current document title, if any. */
  readonly documentTitle?: () => string | undefined;
  /** Frame id for sub-frame reports (top frame omits it). */
  readonly frameId?: number;
  /**
   * What the page has fetched so far (Resource Timing). Injected rather than read
   * here, so this module stays a pure function of its dependencies and the entry
   * keeps the browser globals (§8.10, ADR-012).
   */
  readonly observedResources?: () => readonly WireObservedResource[];
  /** How many frames this document embeds; the background uses it to decide whether
   *  reaching into frames is worth doing at all. */
  readonly frameCount?: () => number;
  /**
   * The cross-origin origins this document embeds. Injected for the same reason as
   * the rest: the observer stays a pure function of its dependencies (§8.10).
   */
  readonly frameOrigins?: () => readonly string[];
  /** Deliver a report to the background. */
  readonly sendReport: (report: DetectionReport) => void;
  /**
   * Schedule `run` after the debounce interval; returns a cancel function. The entry
   * injects a real timer; tests inject a controllable one.
   */
  readonly scheduleScan: (run: () => void, delayMs: number) => () => void;
  /**
   * Debounce floor, and the interval an active page is scanned at. Grows up to
   * {@link ContentObserverDeps.maxIntervalMs} while scans keep finding nothing new.
   */
  readonly intervalMs?: number;
  readonly maxIntervalMs?: number;
}

/** Default debounce, and the ceiling backing off reaches on a page that never settles. */
const DEFAULT_INTERVAL_MS = 200;
const DEFAULT_MAX_INTERVAL_MS = 2000;

export function createContentObserver(deps: ContentObserverDeps): ContentObserver {
  let cancelPending: (() => void) | undefined;
  const baseInterval = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxInterval = Math.max(baseInterval, deps.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS);
  /** What the last SENT report said, so an identical one can be left unsent. */
  let lastSent: string | undefined;
  /** Current debounce, doubled each time a scan finds nothing new. */
  let interval = baseInterval;

  const clearPending = (): void => {
    if (cancelPending !== undefined) {
      cancelPending();
      cancelPending = undefined;
    }
  };

  const scanAndReport = (force: boolean): void => {
    cancelPending = undefined;
    // The page URL is also the base every relative `src`/`href` is resolved against;
    // without it a page whose media uses relative URLs reported paths the background
    // could only refuse (§8.10, §13.5).
    const pageUrl = deps.pageUrl();
    const { domSignals, observedUrls } = scanDocument(deps.document, pageUrl);
    const title = deps.documentTitle?.();
    const resources = deps.observedResources?.() ?? [];
    const frames = deps.frameCount?.() ?? 0;
    const frameOrigins = deps.frameOrigins?.() ?? [];
    const report: DetectionReport = {
      pageUrl,
      domSignals,
      observedUrls,
      ...(resources.length > 0 && { observedResources: resources }),
      ...(frames > 0 && { frameCount: frames }),
      ...(frameOrigins.length > 0 && { frameOrigins }),
      ...(title !== undefined && title !== '' && { documentTitle: title }),
      ...(deps.frameId !== undefined && { frameId: deps.frameId }),
    };

    // Serialising the report costs tens of microseconds and saves a cross-process
    // message carrying hundreds of observations, plus everything the background would
    // do with it. On a page that is only playing, that is the whole cost.
    const signature = JSON.stringify(report);
    if (!force && signature === lastSent) {
      // Nothing new to say. Say it less often, up to the ceiling — a page whose DOM
      // never stops moving must not keep the extension scanning at full rate.
      interval = Math.min(interval * 2, maxInterval);
      return;
    }
    interval = baseInterval;
    lastSent = signature;
    deps.sendReport(report);
  };

  return {
    notify(): void {
      clearPending();
      cancelPending = deps.scheduleScan(() => {
        scanAndReport(false);
      }, interval);
    },
    flush(): void {
      clearPending();
      scanAndReport(true);
    },
    dispose(): void {
      clearPending();
    },
  };
}
