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
const MEDIA_EVENTS = ['loadedmetadata', 'loadeddata', 'emptied', 'durationchange'] as const;

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
  for (const type of MEDIA_EVENTS) {
    document.addEventListener(type, onMediaEvent, true);
  }

  const teardown = (): void => {
    world[ALREADY_INJECTED] = false;
    observer.dispose();
    mutationObserver.disconnect();
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
