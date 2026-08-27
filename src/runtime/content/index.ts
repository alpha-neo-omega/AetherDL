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
import { MAX_FRAME_ORIGINS, MAX_OBSERVED_RESOURCES } from '@shared/constants';
import type { WireObservedResource } from '@shared/types';
import { manifestTypeFromUrl } from '@shared/utils';
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
/**
 * What has been seen on this page's timeline, kept because the timeline does not keep
 * it.
 *
 * Resource Timing is a fixed-size buffer, and a stream fetches hundreds of segments:
 * the playlist entry that started a 34-minute video is evicted long before the user
 * looks again, and a page that plainly HAS a stream then reports one with no playlist
 * in it. Pages also clear the buffer themselves. What was observed while this script
 * was alive is therefore accumulated here rather than re-read each time.
 *
 * Bounded, and the bound protects the useful entries: when it is reached, the oldest
 * entry that does NOT name a manifest is dropped first, because a playlist is the one
 * thing on this list worth keeping.
 */
const seenResources = new Map<string, WireObservedResource>();

function remember(resource: WireObservedResource): void {
  if (seenResources.has(resource.url)) {
    return;
  }
  if (seenResources.size >= MAX_OBSERVED_RESOURCES) {
    for (const url of seenResources.keys()) {
      if (manifestTypeFromUrl(url) === undefined) {
        seenResources.delete(url);
        break;
      }
    }
    if (seenResources.size >= MAX_OBSERVED_RESOURCES) {
      // Every remembered entry names a manifest. Keeping them beats replacing one.
      return;
    }
  }
  seenResources.set(resource.url, resource);
}

function observedResources(): readonly WireObservedResource[] {
  let entries: readonly PerformanceEntry[] = [];
  try {
    entries = performance.getEntriesByType('resource');
  } catch {
    return [...seenResources.values()];
  }
  for (const entry of entries) {
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
    remember({
      url,
      ...(initiator !== '' && { initiatorType: initiator }),
      ...(size > 0 && { sizeBytes: size }),
    });
  }
  return [...seenResources.values()];
}

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
    frameCount: () => document.querySelectorAll('iframe, frame').length,
    frameOrigins,
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
