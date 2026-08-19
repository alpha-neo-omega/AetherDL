// @vitest-environment jsdom
/**
 * Performance: the content script's lifecycle on a real page
 * (PROJECT_BIBLE.md §8.10, §12.4, §12.8).
 *
 * The content script is the only AetherDL code that runs inside a page, so its
 * observation must be scoped and debounced while it lives and leave nothing behind
 * when the page goes away. The entry module is exercised here as the browser runs
 * it: imported for its side effect, driven through mutations, then unloaded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeWebExt, type FakeWebExt } from '../unit/platform/_fake-webext';

interface ObserveCall {
  readonly target: Node;
  readonly options: MutationObserverInit;
}

const observeCalls: ObserveCall[] = [];
let disconnects = 0;
let liveObservers = 0;

/** A MutationObserver that records how the content script scopes its observation. */
class RecordingMutationObserver {
  constructor(private readonly callback: () => void) {
    liveObservers += 1;
  }

  static latest: RecordingMutationObserver | undefined;

  observe(target: Node, options: MutationObserverInit): void {
    observeCalls.push({ target, options });
    RecordingMutationObserver.latest = this;
  }

  disconnect(): void {
    disconnects += 1;
    liveObservers -= 1;
  }

  takeRecords(): readonly unknown[] {
    return [];
  }

  /** Simulate the browser reporting a DOM change. */
  fire(): void {
    this.callback();
  }
}

let fake: FakeWebExt;
let addedListeners: string[];
let removedListeners: string[];

/** Load the content entry the way the browser injects it: for its side effect. */
async function inject(): Promise<void> {
  vi.resetModules();
  await import('@runtime/content/index');
}

/** A fresh page: a navigation gives the isolated world a brand-new global. */
function newPage(): void {
  delete (globalThis as Record<string, unknown>)['__aetherdlContentScript'];
}

beforeEach(() => {
  observeCalls.length = 0;
  disconnects = 0;
  liveObservers = 0;
  addedListeners = [];
  removedListeners = [];
  fake = createFakeWebExt();
  newPage();
  (globalThis as { chrome?: unknown }).chrome = fake.api;
  vi.stubGlobal('MutationObserver', RecordingMutationObserver);

  const documentAdd = document.addEventListener.bind(document);
  const documentRemove = document.removeEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation(((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    addedListeners.push(type);
    documentAdd(type, listener, options);
  }) as typeof document.addEventListener);
  vi.spyOn(document, 'removeEventListener').mockImplementation(((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => {
    removedListeners.push(type);
    documentRemove(type, listener, options);
  }) as typeof document.removeEventListener);

  vi.useFakeTimers();
});

afterEach(() => {
  // Unload whatever this test injected: jsdom's window outlives the test, so a
  // content script left running would leak into the next one.
  window.dispatchEvent(new Event('pagehide'));
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (globalThis as { chrome?: unknown }).chrome;
  document.body.innerHTML = '';
});

describe('content script lifecycle (§8.10, §12.8)', () => {
  it('observes only the attributes detection needs', async () => {
    await inject();

    expect(observeCalls).toHaveLength(1);
    const call = observeCalls[0];
    expect(call?.target).toBe(document.documentElement);
    // Scoped observation: attribute changes are filtered to the three that can
    // change a media URL, so ordinary page churn costs nothing (§12.4).
    expect(call?.options.attributeFilter).toEqual(['src', 'href', 'currentsrc']);
    expect(call?.options.characterData).toBeUndefined();
  });

  it('debounces a mutation storm into a single report', async () => {
    document.body.innerHTML = '<video src="https://cdn.example.com/clip.mp4"></video>';
    await inject();
    const sent: unknown[] = [];
    const observer = RecordingMutationObserver.latest;
    expect(observer).toBeDefined();

    // Capture what the content script sends to the background.
    const bus = fake.api.runtime;
    const original = bus.sendMessage.bind(bus);
    bus.sendMessage = (message: unknown): Promise<unknown> => {
      sent.push(message);
      return original(message);
    };

    for (let index = 0; index < 200; index += 1) {
      observer?.fire();
    }
    expect(sent).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(200);

    // 200 mutations, one report — the debounce collapses the storm (§12.4).
    expect(sent).toHaveLength(1);
  });

  it('releases every page resource when the page unloads', async () => {
    document.body.innerHTML = '<video src="https://cdn.example.com/clip.mp4"></video>';
    await inject();
    const sent: unknown[] = [];
    const bus = fake.api.runtime;
    const original = bus.sendMessage.bind(bus);
    bus.sendMessage = (message: unknown): Promise<unknown> => {
      sent.push(message);
      return original(message);
    };

    const observer = RecordingMutationObserver.latest;
    observer?.fire();
    expect(vi.getTimerCount()).toBe(1);

    window.dispatchEvent(new Event('pagehide'));

    // Observer disconnected, debounce timer cleared, media listeners removed — the
    // §12.8 checklist for this surface.
    expect(disconnects).toBe(1);
    expect(liveObservers).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    for (const type of ['loadedmetadata', 'loadeddata', 'emptied', 'durationchange']) {
      expect(removedListeners).toContain(type);
    }
    expect(new Set(removedListeners).size).toBeGreaterThanOrEqual(
      new Set(addedListeners.filter((type) => type !== 'DOMContentLoaded')).size,
    );

    // And nothing reports after unload: a media event that would have triggered a
    // scan now reaches no listener, and the cancelled scan never fires late.
    document.querySelector('video')?.dispatchEvent(new Event('loadedmetadata', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('leaves nothing behind across repeated page loads', async () => {
    for (let load = 0; load < 20; load += 1) {
      newPage();
      await inject();
      RecordingMutationObserver.latest?.fire();
      window.dispatchEvent(new Event('pagehide'));

      expect(liveObservers, `load ${String(load)}`).toBe(0);
      expect(disconnects, `load ${String(load)}`).toBe(load + 1);
      expect(vi.getTimerCount(), `load ${String(load)}`).toBe(0);
    }
  });
});

describe('content script injection is idempotent (§12.4, §12.8)', () => {
  it('ignores a second injection into the same page', async () => {
    await inject();
    expect(observeCalls).toHaveLength(1);

    // The background injects again on the next popup open; the page must not end up
    // with two observers and two debounce timers.
    await inject();

    expect(observeCalls).toHaveLength(1);
    expect(liveObservers).toBe(1);
  });

  it('observes the next page after a navigation', async () => {
    await inject();
    window.dispatchEvent(new Event('pagehide'));
    expect(liveObservers).toBe(0);

    newPage();
    await inject();

    expect(observeCalls).toHaveLength(2);
    expect(liveObservers).toBe(1);
  });
});
