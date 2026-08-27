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
import { MAX_FRAME_ORIGINS } from '@shared/constants';
import type { WireObservedResource } from '@shared/types';
import { resolveWebExtApi } from '@platform/browser/webext';
import { createMessageBus } from '@platform/messaging/service';
import { createContentObserver } from '@runtime/content/observer';
import {
  createResourceTimeline,
  isInterestingInitiator,
  type TimelineEntry,
} from '@runtime/content/timeline';
import type { DocumentLike } from '@runtime/content/scan';

/**
 * Marker on the isolated world's global, so a second injection into the SAME page
 * does nothing. The background injects on every gesture-backed refresh (§8.10), and
 * a page can be refreshed repeatedly; without this each injection would add another
 * MutationObserver and another debounce timer to the page (§12.4, §12.8). A real
 * navigation gives the page a fresh global, so the next page is observed normally.
 */
const ALREADY_INJECTED = '__aetherdlContentScript';

/**
 * A way back in for an injection that finds the script already running.
 *
 * The background re-injects on every gesture-backed refresh, and its own state is
 * in-memory: a suspended service worker comes back knowing nothing about the tab. The
 * marker above then made the re-injection a no-op, so the only thing that could restore
 * what the page holds was the next DOM mutation — and a video that is simply playing
 * may not produce one. The popup showed a page with nothing on it.
 *
 * So the already-running instance is asked to report again instead (§8.10).
 */
const RESCAN = '__aetherdlContentRescan';

const MEDIA_EVENTS = ['loadedmetadata', 'loadeddata', 'emptied', 'durationchange'] as const;

/**
 * What the page has fetched, as plain data.
 *
 * Read from the page's own timeline — no request is made here, and nothing is
 * intercepted. Whether any of these URLs is media is decided later, from their bytes.
 */
/**
 * The distinct cross-origin origins this document embeds players from.
 *
 * Read from the frame elements' own `src` attributes — the one thing about a
 * cross-origin frame a page IS allowed to see. Nothing is loaded, nothing is entered:
 * the frame's document stays as unreachable as it was. The origins travel to the
 * background so a surface can name the site and ask the user whether to opt it in
 * (§8.10, §13.7).
 *
 * Same-origin frames are left out because they are already reachable, and non-http
 * frames (`about:blank`, `data:`, a sandboxed shell) because no host permission
 * exists to grant for them.
 */
function frameOrigins(): readonly string[] {
  const out = new Set<string>();
  let frames: readonly Element[] = [];
  try {
    frames = [...document.querySelectorAll('iframe, frame')];
  } catch {
    return [];
  }
  for (const frame of frames) {
    if (out.size >= MAX_FRAME_ORIGINS) {
      break;
    }
    const src = frame.getAttribute('src');
    if (src === null || src === '') {
      continue;
    }
    try {
      const url = new URL(src, location.href);
      if (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        url.origin !== location.origin
      ) {
        out.add(url.origin);
      }
    } catch {
      // A malformed `src` names no origin to ask about.
    }
  }
  return [...out];
}

/**
 * What the page has fetched, as plain data.
 *
 * Read from the page's own timeline — no request is made here, and nothing is
 * intercepted. Whether any of these URLs is media is decided later, from their bytes.
 * The bounding and accumulation live in `./timeline`, where they can be tested.
 */
const timeline = createResourceTimeline();

function observedResources(): readonly WireObservedResource[] {
  try {
    return timeline.harvest(
      performance.getEntriesByType('resource') as unknown as readonly TimelineEntry[],
    );
  } catch {
    // No timeline to read is not the same as nothing observed: what was seen earlier
    // still stands.
    return timeline.harvest([]);
  }
}

function start(): void {
  const world = globalThis as Record<string, unknown>;
  if (world[ALREADY_INJECTED] === true) {
    const rescan = world[RESCAN];
    if (typeof rescan === 'function') {
      (rescan as () => void)();
    }
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
    frameCount: () => document.querySelectorAll('iframe, frame').length,
    frameOrigins,
    sendReport: (report) => {
      void bus.send('detection/run', report).catch(() => undefined);
    },
    scheduleScan: (run, delayMs) => {
      const handle = setTimeout(run, delayMs);
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
      // Harvested here as well as on each scan: an observer is delivered entries the
      // BUFFER never records, because Resource Timing stops recording once it is full.
      // This is the only sight the extension gets of a playlist fetched late on a page
      // that has already made a few hundred requests.
      const entries = list.getEntries() as unknown as readonly TimelineEntry[];
      timeline.harvest(entries);
      for (const entry of entries) {
        if (isInterestingInitiator(entry.initiatorType)) {
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

  world[RESCAN] = (): void => {
    observer.flush();
  };

  const teardown = (): void => {
    world[ALREADY_INJECTED] = false;
    delete world[RESCAN];
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
