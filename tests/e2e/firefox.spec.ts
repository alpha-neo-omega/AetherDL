/**
 * Browser e2e — Firefox / Gecko (PROJECT_BIBLE.md §16.3, §7.4).
 *
 * Three things are verified against the REAL `dist/firefox` build:
 *
 *  1. the package passes Mozilla's own add-on linter (web-ext, ADR-008) — the same
 *     validation AMO runs at submission;
 *  2. the extension INSTALLED in a real Firefox works: manifest identity, popup,
 *     detection, a native download, history, settings persistence, and the
 *     context-menu capability correctly reporting itself absent (§7.4); and
 *  3. the shipped bundles run in Gecko under Playwright, where request interception
 *     can prove that nothing remote is loaded.
 *
 * Playwright cannot install a WebExtension into Firefox, so the installed-extension
 * tests drive Firefox over Marionette, its own automation protocol
 * (tests/e2e/_fixtures/firefox.ts) — no new dependency, and the add-on is installed
 * exactly as `about:debugging` installs it.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { DetectionReport, Settings } from '../../src/shared/types';
import { distDir, REPO_ROOT } from './_fixtures/extension';
import { installFirefoxExtension, requestScript, type InstalledFirefox } from './_fixtures/firefox';
import { startFixtureSite, type FixtureSite } from './_fixtures/server';

const run = promisify(execFile);

interface LinterResult {
  readonly errors: readonly { readonly code: string; readonly message: string }[];
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

/** What the stubbed namespace records, so a test can assert what a page sent. */
interface ProbeWindow {
  __adlSent?: { type: string; payload: unknown }[];
  __adlReports?: DetectionReport[];
}

/**
 * Stand in for the browser's WebExtension namespace: storage that really persists
 * for the page's lifetime, messaging that records what the surface sent and answers
 * with the same shapes the background does. Only the transport is stubbed; the code
 * under test is the shipped bundle.
 */
async function stubWebExtensionApi(page: Page, settings: Partial<Settings> = {}): Promise<void> {
  await page.addInitScript((overrides: Partial<Settings>) => {
    const target = globalThis as ProbeWindow & { browser?: unknown; chrome?: unknown };
    target.__adlSent = [];
    target.__adlReports = [];
    const noop = (): void => undefined;
    const event = { addListener: noop, removeListener: noop, hasListener: () => false };

    const catalogue: Record<string, unknown> = {
      theme: 'system',
      maxConcurrentDownloads: 3,
      maxRetries: 3,
      filenameTemplate: '{title}.{ext}',
      downloadSubfolder: '',
      notifications: true,
      keepHistory: true,
      historyRetention: 'forever',
      duplicateWarnings: true,
      contextMenu: true,
      reducedMotion: 'system',
      language: 'system',
      detectionSensitivity: 'balanced',
      ...overrides,
    };

    const answer = (type: string, payload: unknown): unknown => {
      switch (type) {
        case 'settings/get':
        case 'settings/update':
          Object.assign(catalogue, (payload as Record<string, unknown>) ?? {});
          return catalogue;
        case 'settings/reset':
          return catalogue;
        case 'detection/query':
        case 'detection/refresh':
        case 'download/query':
        case 'download/progress':
        case 'history/query':
          return [];
        case 'download/stats':
          return { total: 0, queued: 0, active: 0, completed: 0, failed: 0 };
        default:
          return undefined;
      }
    };

    const api = {
      runtime: {
        id: 'aetherdl@aetherdl.app',
        getManifest: () => ({ manifest_version: 3, version: '0.1.0' }),
        getURL: (path: string) => path,
        sendMessage: (message: {
          kind?: string;
          type?: string;
          payload?: unknown;
          id?: string;
        }) => {
          if (message?.kind === 'request' && typeof message.type === 'string') {
            target.__adlSent?.push({ type: message.type, payload: message.payload });
            if (message.type === 'detection/run') {
              target.__adlReports?.push(message.payload as DetectionReport);
            }
            return Promise.resolve({
              __aetherdl_msg__: true,
              kind: 'response',
              id: message.id,
              ok: true,
              payload: answer(message.type, message.payload),
              error: undefined,
            });
          }
          return Promise.resolve(undefined);
        },
        onMessage: event,
        onInstalled: event,
        onStartup: event,
      },
      tabs: { query: () => Promise.resolve([{ id: 1, active: true }]), onUpdated: event },
      i18n: { getMessage: () => '', getUILanguage: () => 'en-US' },
      storage: {
        local: {
          get: () => Promise.resolve({}),
          set: () => Promise.resolve(),
          remove: () => Promise.resolve(),
        },
      },
      permissions: {
        contains: () => Promise.resolve(false),
        request: () => Promise.resolve(false),
        remove: () => Promise.resolve(true),
      },
      downloads: { download: () => Promise.resolve(1), onChanged: event },
      action: {
        setBadgeText: () => Promise.resolve(),
        setBadgeBackgroundColor: () => Promise.resolve(),
        setTitle: () => Promise.resolve(),
      },
      scripting: { executeScript: () => Promise.resolve([]) },
    };
    target.browser = api;
    target.chrome = api;
  }, settings);
}

test.describe('AetherDL in Firefox', () => {
  test.describe.configure({ mode: 'serial' });

  let site: FixtureSite;
  let pages: FixtureSite;

  test.beforeAll(async () => {
    site = await startFixtureSite();
    // The built extension itself, served so Gecko loads the real bundles over http.
    pages = await startFixtureSite(distDir('firefox'));
  });

  test.afterAll(async () => {
    await site.close();
    await pages.close();
  });

  test('passes Mozilla’s add-on linter with no errors', async () => {
    const { stdout } = await run(
      process.execPath,
      [
        join(REPO_ROOT, 'node_modules', 'web-ext', 'bin', 'web-ext.js'),
        'lint',
        '--source-dir',
        distDir('firefox'),
        '--output',
        'json',
        '--no-config-discovery',
      ],
      { cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024 },
    );
    const result = JSON.parse(stdout) as LinterResult;

    // Errors block an AMO submission; warnings are reported in the Phase 9 findings.
    expect(result.errors).toEqual([]);
  });

  test('runs the shipped content script against a real Gecko DOM', async ({ page }) => {
    await page.addInitScript(() => {
      const target = globalThis as ProbeWindow & { browser?: unknown };
      target.__adlReports = [];
      const noop = (): void => undefined;
      target.browser = {
        runtime: {
          id: 'probe',
          getManifest: () => ({ manifest_version: 3, version: '0.1.0' }),
          getURL: (path: string) => path,
          sendMessage: (message: { payload?: DetectionReport }) => {
            if (message?.payload !== undefined) {
              target.__adlReports?.push(message.payload);
            }
            return Promise.resolve(undefined);
          },
          onMessage: { addListener: noop, removeListener: noop, hasListener: () => false },
        },
      };
    });
    await page.goto(`${site.origin}/with-media.html`);
    await page.addScriptTag({ path: join(distDir('firefox'), 'content.js') });

    await expect
      .poll(() => page.evaluate(() => (globalThis as ProbeWindow).__adlReports?.length ?? 0))
      .toBeGreaterThan(0);
    const report = await page.evaluate(() => (globalThis as ProbeWindow).__adlReports?.[0]);

    // Gecko's DOM, the same observations Chromium produced (§7.2 parity).
    const seen = [
      ...(report?.domSignals ?? []).map((signal) => signal.src ?? signal.href ?? ''),
      ...(report?.observedUrls ?? []),
    ];
    expect(seen).toContain(`${site.origin}/media/sample.mp4`);
    expect(seen).toContain(`${site.origin}/media/sample.mp3`);
  });

  test('mounts the popup bundle in Gecko and asks the background for the tab’s media', async ({
    page,
  }) => {
    await stubWebExtensionApi(page);
    await page.goto(`${pages.origin}/popup.html`);

    await expect(page.locator('.adl-toolbar')).toBeVisible();
    await expect(page.locator('.adl-status')).toBeVisible();

    const sent = await page.evaluate(() => (globalThis as ProbeWindow).__adlSent ?? []);
    const types = sent.map((message) => message.type);
    // The popup drives the approved contract, nothing else (§8.5).
    expect(types).toContain('detection/query');
    expect(types).toContain('download/query');
    expect(types).toContain('detection/refresh');
    expect(types.every((type) => /^(detection|download|settings|history)\//.test(type))).toBe(true);
  });

  test('mounts the settings bundle in Gecko and applies a change', async ({ page }) => {
    await stubWebExtensionApi(page);
    await page.goto(`${pages.origin}/settings.html`);

    const toggle = page.getByRole('checkbox', { name: /duplicate/i });
    await expect(toggle).toBeVisible();
    await toggle.click();

    await expect
      .poll(async () => {
        const sent = await page.evaluate(() => (globalThis as ProbeWindow).__adlSent ?? []);
        return sent.filter((message) => message.type === 'settings/update').length;
      })
      .toBeGreaterThan(0);

    const sent = await page.evaluate(() => (globalThis as ProbeWindow).__adlSent ?? []);
    const update = sent.find((message) => message.type === 'settings/update');
    expect(update?.payload).toEqual({ duplicateWarnings: false });
  });

  test('loads no remote resource', async ({ page }) => {
    const foreign: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith(pages.origin)) {
        foreign.push(request.url());
      }
    });
    await stubWebExtensionApi(page);
    await page.goto(`${pages.origin}/settings.html`);
    await page.waitForTimeout(1000);

    // No remote fonts, scripts, images or telemetry — verified in Gecko (§13.2, §14.3).
    expect(foreign).toEqual([]);
  });
});

test.describe('AetherDL installed in a real Firefox', () => {
  test.describe.configure({ mode: 'serial' });

  let firefox: InstalledFirefox;
  let media: FixtureSite;

  test.beforeAll(async () => {
    media = await startFixtureSite();
    firefox = await installFirefoxExtension();
  });

  test.afterAll(async () => {
    await firefox.close();
    await media.close();
  });

  test('installs as an MV3 add-on with the least-privilege permission set', async () => {
    await firefox.open('popup.html');
    const manifest = await firefox.script<{
      manifest_version: number;
      permissions: string[];
      optional_permissions?: string[];
      host_permissions?: string[];
    }>('return browser.runtime.getManifest();');

    expect(manifest.manifest_version).toBe(3);
    // No `offscreen`: a Firefox event page already has the DOM APIs assembly needs.
    expect(manifest.permissions).toEqual(['storage', 'downloads', 'activeTab', 'scripting']);
    // No install-time host permission, and — asked of the browser itself — no host
    // access actually granted. The stream pattern is optional and requested at
    // point of use (§13.7).
    expect(manifest.host_permissions ?? []).toEqual([]);
    const granted = await firefox.script<{ origins: string[] }>(
      'return browser.permissions.getAll();',
    );
    expect(granted.origins).toEqual([]);
    // No menus permission anywhere on Firefox — neither required nor optional (§13.3).
    expect(manifest.optional_permissions).toEqual(['notifications']);
  });

  test('renders the popup', async () => {
    await firefox.open('popup.html');
    const text = await firefox.script<string>('return document.body.innerText;');
    const toolbars = await firefox.script<number>(
      'return document.querySelectorAll(".adl-toolbar").length;',
    );

    expect(toolbars).toBe(1);
    expect(text).toContain('AetherDL');
  });

  test('detects media reported for the tab and badges it', async () => {
    await firefox.open('popup.html');
    const items = await firefox.asyncScript<{ id: string; url: string; status: string }[]>(
      requestScript('detection/run', {
        pageUrl: `${media.origin}/with-media.html`,
        domSignals: [
          {
            role: 'video',
            tagName: 'VIDEO',
            src: `${media.origin}/media/sample.mp4`,
            width: 1280,
            height: 720,
          },
        ],
        observedUrls: [],
      }),
    );

    expect(items.length).toBeGreaterThan(0);
    expect(items.some((item) => item.url === `${media.origin}/media/sample.mp4`)).toBe(true);

    const badge = await firefox.until(
      'the badge to report detected media',
      () =>
        firefox.asyncScript<string>(
          'const [tab] = await browser.tabs.query({ active: true, currentWindow: true }); return browser.action.getBadgeText({ tabId: tab.id });',
        ),
      (text) => text !== '',
    );
    expect(Number(badge)).toBe(items.filter((item) => item.status === 'supported').length);
  });

  test('downloads through Firefox’s native downloads API and records history', async () => {
    await firefox.open('popup.html');
    const items = await firefox.asyncScript<{ id: string }[]>(
      requestScript('detection/run', {
        pageUrl: `${media.origin}/with-media.html`,
        domSignals: [{ role: 'video', tagName: 'VIDEO', src: `${media.origin}/media/sample.mp4` }],
        observedUrls: [],
      }),
    );
    const first = items[0];
    expect(first).toBeDefined();

    await firefox.asyncScript(requestScript('download/enqueue', { itemIds: [first?.id ?? ''] }));

    const downloads = await firefox.until(
      'the native download to complete',
      () =>
        firefox.asyncScript<{ state: string; url: string; bytesReceived: number }[]>(
          'const found = await browser.downloads.search({}); return found.map((item) => ({ state: item.state, url: item.url, bytesReceived: item.bytesReceived }));',
        ),
      (found) => found.some((item) => item.state === 'complete'),
    );
    const completed = downloads.find((item) => item.state === 'complete');
    expect(completed?.url).toBe(`${media.origin}/media/sample.mp4`);
    expect(completed?.bytesReceived).toBeGreaterThan(0);

    const queue = await firefox.asyncScript<{ state: string; filename: string }[]>(
      requestScript('download/query', undefined),
    );
    const done = queue.find((task) => task.state === 'completed');
    expect(done).toBeDefined();
    // The doubled-extension defect would show here as `sample.mp4.mp4` (§10.7).
    expect(done?.filename).toBe('sample.mp4');

    const history = await firefox.until(
      'the transfer to reach local history',
      () => firefox.asyncScript<{ outcome: string }[]>(requestScript('history/query', undefined)),
      (records) => records.length > 0,
    );
    expect(history[0]?.outcome).toBe('completed');
  });

  test('persists a settings change across a reload', async () => {
    await firefox.open('settings.html');
    const before = await firefox.asyncScript<boolean>(
      `${requestScript('settings/get', undefined)}`.replace(
        'return response.payload;',
        'return response.payload.duplicateWarnings;',
      ),
    );

    await firefox.asyncScript(requestScript('settings/update', { duplicateWarnings: !before }));
    await firefox.open('settings.html');
    const after = await firefox.asyncScript<boolean>(
      `${requestScript('settings/get', undefined)}`.replace(
        'return response.payload;',
        'return response.payload.duplicateWarnings;',
      ),
    );

    expect(after).toBe(!before);
  });

  test('has no context-menu capability, and offers no control for it', async () => {
    await firefox.open('settings.html');
    await firefox.until(
      'the settings page to finish mounting',
      () => firefox.script<string>('return document.body.innerText;'),
      (text) => !text.includes('Loading settings'),
    );
    const state = await firefox.script<{
      menus: boolean;
      contextMenus: boolean;
      grantButtons: number;
      bodyText: string;
    }>(`return {
        menus: typeof browser.menus !== 'undefined',
        contextMenus: typeof browser.contextMenus !== 'undefined',
        grantButtons: [...document.querySelectorAll('button')]
          .filter((button) => /context menu/i.test(button.textContent || '')).length,
        bodyText: document.body.innerText,
      };`);

    // Nothing pretends the capability exists, and no dead control is offered (§7.2).
    expect(state.menus).toBe(false);
    expect(state.contextMenus).toBe(false);
    expect(state.grantButtons).toBe(0);
    expect(state.bodyText).toContain('Notifications');
    expect(state.bodyText).not.toContain('Context menu entries');
  });

  test('reports no error to the user while running without menus', async () => {
    await firefox.open('popup.html');
    await firefox.until(
      'the popup to settle',
      () => firefox.script<string>('return document.body.innerText;'),
      (text) => !text.includes('Loading'),
    );
    const status = await firefox.script<string>(
      'return (document.querySelector(".adl-status__title") || {}).textContent || "";',
    );
    expect(status).not.toMatch(/error|failed/i);
  });
});
