/**
 * E2E harness: load the real, built extension into a real browser
 * (PROJECT_BIBLE.md §16.3). Nothing here mocks the extension — it loads
 * `dist/<target>` exactly as a user would install it, and talks to it only over the
 * ratified message contract (§8.5). Not a test file.
 */
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..', '..');

export function distDir(target: 'chrome' | 'firefox'): string {
  const dir = resolve(REPO_ROOT, 'dist', target);
  if (!existsSync(join(dir, 'manifest.json'))) {
    throw new Error(`dist/${target} is not built — run "npm run build" before the e2e suite`);
  }
  return dir;
}

export interface LoadedExtension {
  readonly context: BrowserContext;
  /** The MV3 service worker: the background surface, as the browser runs it. */
  readonly worker: Worker;
  readonly extensionId: string;
  /** Open one of the extension's own pages (popup/settings) in a tab. */
  page(path: string): Promise<Page>;
  close(): Promise<void>;
}

/**
 * Launch Chromium with the unpacked build installed. The full browser channel is
 * required: the headless shell does not load extensions. `sourceDir` defaults to
 * `dist/chrome`; the release suite passes an EXTRACTED artifact instead, so what a
 * store would receive is what gets installed.
 */
export async function loadChromiumExtension(sourceDir?: string): Promise<LoadedExtension> {
  const dir = sourceDir ?? distDir('chrome');
  const profile = mkdtempSync(join(tmpdir(), 'aetherdl-e2e-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });

  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 30_000 }));
  const extensionId = new URL(worker.url()).host;

  return {
    context,
    worker,
    extensionId,
    async page(path: string): Promise<Page> {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/${path}`);
      return page;
    },
    close: () => context.close(),
  };
}

/**
 * The ratified request envelope (§8.5, `src/platform/messaging/service.ts`). An
 * extension page is a first-class messaging context, so sending one of these is a
 * real message on the real bus — the same bytes the popup puts on the wire.
 */
export interface WireRequest {
  readonly type: string;
  readonly payload?: unknown;
}

/** Send a typed request from an extension page and return the handler's response. */
export async function sendMessage<T>(page: Page, request: WireRequest): Promise<T> {
  return page.evaluate(async ({ type, payload }) => {
    const response = (await chrome.runtime.sendMessage({
      __aetherdl_msg__: true,
      kind: 'request',
      type,
      payload,
      id: crypto.randomUUID(),
    })) as { ok: boolean; payload: unknown; error?: { message: string } };
    if (response === undefined || !response.ok) {
      throw new Error(response?.error?.message ?? `no handler answered "${type}"`);
    }
    return response.payload as T;
  }, request) as Promise<T>;
}

/** Poll until `read` returns a value the predicate accepts, or fail with context. */
export async function until<T>(
  what: string,
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) {
      return last;
    }
    await new Promise((wait) => setTimeout(wait, 100));
  }
  throw new Error(`timed out waiting for ${what}; last value: ${JSON.stringify(last)}`);
}
