// @vitest-environment jsdom
/**
 * Regression (PROJECT_BIBLE.md §16.5): injecting the content script on every
 * gesture-backed refresh made a page that the user opened the popup on twice run
 * two content scripts — two MutationObservers, two debounce timers, two reports per
 * change. Fixed by marking the isolated world on first run (§12.4, §12.8).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeWebExt } from '../unit/platform/_fake-webext';

let observers = 0;

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
  (globalThis as { chrome?: unknown }).chrome = createFakeWebExt().api;
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

  it('still observes the next page after a navigation', async () => {
    await inject();
    window.dispatchEvent(new Event('pagehide'));
    expect(observers).toBe(0);

    newPage();
    await inject();

    expect(observers).toBe(1);
  });
});
