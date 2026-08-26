/**
 * Module: runtime/content (entry)
 * Purpose: Content-script entry — isolated world only (PROJECT_BIBLE.md §8.10,
 *          §13.6). Observes DOM readiness, mutations, and media-element changes;
 *          collects observations via the pure scanner; reports them to the background
 *          through the typed message bus. Performs NO detection.
 * Restrictions: Isolated world ONLY (§13.6). Thin composition of the observer with
 *          real DOM/event sources + platform messaging. All observers/listeners are
 *          detached on unload (§12.8). Coverage-excluded (touches DOM globals); the
 *          observable logic lives in ./observer and ./scan and is unit-tested.
 */
import { MAX_OBSERVED_RESOURCES } from '@shared/constants';
import type { WireObservedResource } from '@shared/types';
import { resolveWebExtApi } from '@platform/browser/webext';
import { createMessageBus } from '@platform/messaging/service';
import { createContentObserver } from '@runtime/content/observer';
import type { DocumentLike } from '@runtime/content/scan';

const SCAN_DEBOUNCE_MS = 200;

/**
 * Marker on the isolated world's global, so a second injection into the SAME page
 * does nothing. The background injects on every gesture-backed refresh (§8.10), and
 * a page can be refreshed repeatedly; without this each injection would add another
 * MutationObserver and another debounce timer to the page (§12.4, §12.8). A real
 * navigation gives the page a fresh global, so the next page is observed normally.
 */
const ALREADY_INJECTED = '__aetherdlContentScript';

/**
 * Resource Timing initiators that can carry a stream a player fetched itself.
 *
 * A page loads hundreds of resources; only the script-driven ones can be the playlist
 * a MediaSource is being fed from. Reporting the rest would fill the message with
 * images and fonts (§9.1, ADR-012).
 */
const INTERESTING_INITIATORS = new Set(['xmlhttprequest', 'fetch', 'video', 'audio', 'other', '']);
const MEDIA_EVENTS = ['loadedmetadata', 'loadeddata', 'emptied', 'durationchange'] as const;

/**
 * What the page has fetched, as plain data.
 *
 * Read from the page's own timeline — no request is made here, and nothing is
 * intercepted. Whether any of these URLs is media is decided later, from their bytes.
 */
function observedResources(): readonly WireObservedResource[] {
  const out: WireObservedResource[] = [];
  let entries: readonly PerformanceEntry[] = [];
  try {
    entries = performance.getEntriesByType('resource');
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= MAX_OBSERVED_RESOURCES) {
      break;
    }
    const resource = entry as PerformanceResourceTiming;
    const initiator = (resource.initiatorType ?? '').toLowerCase();
    if (!INTERESTING_INITIATORS.has(initiator)) {
      continue;
    }
    const url = resource.name;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      continue;
    }
    const size = resource.transferSize || resource.encodedBodySize || 0;
    out.push({
      url,
      ...(initiator !== '' && { initiatorType: initiator }),
      ...(size > 0 && { sizeBytes: size }),
    });
  }
  return out;
}

function start(): void {
  const world = globalThis as Record<string, unknown>;
  if (world[ALREADY_INJECTED] === true) {
    return;
  }
  world[ALREADY_INJECTED] = true;

  const { api } = resolveWebExtApi();
  const bus = createMessageBus(api);

  const observer = createContentObserver({
    // Real Document satisfies the structural DocumentLike the scanner reads.
    document: document as unknown as DocumentLike,
    pageUrl: () => location.href,
    documentTitle: () => document.title,
    observedResources,
    sendReport: (report) => {
      void bus.send('detection/run', report).catch(() => undefined);
    },
    scheduleScan: (run) => {
      const handle = setTimeout(run, SCAN_DEBOUNCE_MS);
      return () => {
        clearTimeout(handle);
      };
    },
  });

  const mutationObserver = new MutationObserver(() => {
    observer.notify();
  });
  mutationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'href', 'currentsrc'],
  });

  const onMediaEvent = (): void => {
    observer.notify();
  };

  // A player that fetches its playlist a second after load must not be missed; the
  // observer debounces, so this cannot become a scan per request (§12.4).
  let resourceObserver: PerformanceObserver | undefined;
  try {
    resourceObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const initiator = ((entry as PerformanceResourceTiming).initiatorType ?? '').toLowerCase();
        if (INTERESTING_INITIATORS.has(initiator)) {
          observer.notify();
          return;
        }
      }
    });
    resourceObserver.observe({ type: 'resource', buffered: false });
  } catch {
    // An engine without Resource Timing observation still detects from the DOM.
  }
  for (const type of MEDIA_EVENTS) {
    document.addEventListener(type, onMediaEvent, true);
  }

  const teardown = (): void => {
    world[ALREADY_INJECTED] = false;
    observer.dispose();
    mutationObserver.disconnect();
    resourceObserver?.disconnect();
    for (const type of MEDIA_EVENTS) {
      document.removeEventListener(type, onMediaEvent, true);
    }
    window.removeEventListener('pagehide', teardown);
    bus.dispose();
  };
  window.addEventListener('pagehide', teardown);

  // Initial observation once the DOM is usable.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => observer.notify(), { once: true });
  } else {
    observer.notify();
  }
}

start();
