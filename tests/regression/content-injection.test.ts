// @vitest-environment jsdom
/**
 * Regression (PROJECT_BIBLE.md §16.5): injecting the content script on every
 * gesture-backed refresh made a page that the user opened the popup on twice run
 * two content scripts — two MutationObservers, two debounce timers, two reports per
 * change. Fixed by marking the isolated world on first run (§12.4, §12.8).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeWebExt, type FakeWebExt } from '../unit/platform/_fake-webext';

let observers = 0;
let fake: FakeWebExt;

class CountingMutationObserver {
  constructor(private readonly callback: () => void) {}
  observe(): void {
    observers += 1;
  }
  disconnect(): void {
    observers -= 1;
  }
  takeRecords(): readonly unknown[] {
    return [];
  }
  fire(): void {
    this.callback();
  }
}

/** Inject the shipped entry module the way the background does. */
async function inject(): Promise<void> {
  vi.resetModules();
  await import('@runtime/content/index');
}

/** A navigation gives the isolated world a fresh global. */
function newPage(): void {
  delete (globalThis as Record<string, unknown>)['__aetherdlContentScript'];
}

beforeEach(() => {
  observers = 0;
  newPage();
  fake = createFakeWebExt();
  (globalThis as { chrome?: unknown }).chrome = fake.api;
  vi.stubGlobal('MutationObserver', CountingMutationObserver);
});

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  vi.unstubAllGlobals();
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe('regression: repeated injection stacked observers (Phase 9)', () => {
  it('runs once however many times the page is injected', async () => {
    await inject();
    await inject();
    await inject();

    expect(observers).toBe(1);
  });

  it('reports again when it is injected into a page it is already running on', async () => {
    // The background's state is in-memory: a suspended service worker comes back
    // knowing nothing about the tab, and re-injects to find out. Making that a no-op
    // left the popup showing a page with nothing on it until the DOM next changed —
    // which a video that is simply playing need not do (§8.10).
    const reports: unknown[] = [];
    fake.api.runtime.onMessage.addListener((message: unknown) => {
      reports.push(message);
      return undefined;
    });

    await inject();
    await Promise.resolve();
    const before = reports.length;

    await inject();
    await Promise.resolve();

    expect(reports.length).toBeGreaterThan(before);
    expect(observers).toBe(1);
  });

  it('still observes the next page after a navigation', async () => {
    await inject();
    window.dispatchEvent(new Event('pagehide'));
    expect(observers).toBe(0);

    newPage();
    await inject();

    expect(observers).toBe(1);
  });
});
