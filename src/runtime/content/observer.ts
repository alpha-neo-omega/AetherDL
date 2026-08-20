/**
 * Module: runtime/content/observer
 * Purpose: Coordinate the content script's observe→collect→report loop
 *          (PROJECT_BIBLE.md §8.10). Debounces scans (performance budget, §12) and
 *          reports a `DetectionReport` to the background. Detection is NOT performed
 *          here; the report is the only output.
 * Restrictions: Runtime layer, isolated world. Pure of browser globals — the DOM
 *          event sources and messaging are injected by the entry (index.ts).
 * Public API: ContentObserver, ContentObserverDeps, createContentObserver.
 */
import type { DetectionReport } from '@shared/types';
import type { DocumentLike } from '@runtime/content/scan';
import { scanDocument } from '@runtime/content/scan';

export interface ContentObserver {
  /** Schedule a debounced scan + report. Call on readiness/mutation/media events. */
  notify(): void;
  /** Scan + report immediately, cancelling any pending debounce. */
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
  /** Deliver a report to the background. */
  readonly sendReport: (report: DetectionReport) => void;
  /**
   * Schedule `run` after the debounce interval; returns a cancel function. The entry
   * injects a real timer; tests inject a controllable one.
   */
  readonly scheduleScan: (run: () => void) => () => void;
}

export function createContentObserver(deps: ContentObserverDeps): ContentObserver {
  let cancelPending: (() => void) | undefined;

  const clearPending = (): void => {
    if (cancelPending !== undefined) {
      cancelPending();
      cancelPending = undefined;
    }
  };

  const scanAndReport = (): void => {
    cancelPending = undefined;
    // The page URL is also the base every relative `src`/`href` is resolved against;
    // without it a page whose media uses relative URLs reported paths the background
    // could only refuse (§8.10, §13.5).
    const pageUrl = deps.pageUrl();
    const { domSignals, observedUrls } = scanDocument(deps.document, pageUrl);
    const title = deps.documentTitle?.();
    const report: DetectionReport = {
      pageUrl,
      domSignals,
      observedUrls,
      ...(title !== undefined && title !== '' && { documentTitle: title }),
      ...(deps.frameId !== undefined && { frameId: deps.frameId }),
    };
    deps.sendReport(report);
  };

  return {
    notify(): void {
      clearPending();
      cancelPending = deps.scheduleScan(scanAndReport);
    },
    flush(): void {
      clearPending();
      scanAndReport();
    },
    dispose(): void {
      clearPending();
    },
  };
}
