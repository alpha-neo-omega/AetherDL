/**
 * Browser e2e — Chromium (PROJECT_BIBLE.md §16.3).
 *
 * Drives the real, unpacked build in a real browser: the MV3 service worker, the
 * programmatically injected content script, the React popup and settings pages, and
 * the native `chrome.downloads` transfer. Media comes from a loopback fixture site
 * with non-DRM sample files only (§16.3, §6).
 */
import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import type {
  DetectionReport,
  DownloadTask,
  HistoryRecord,
  MediaItem,
  Settings,
} from '../../src/shared/types';
import {
  distDir,
  loadChromiumExtension,
  sendMessage,
  until,
  type LoadedExtension,
} from './_fixtures/extension';
import { startFixtureSite, type FixtureSite } from './_fixtures/server';

/** What the stubbed page collects from the content script under test. */
interface ReportWindow {
  __adlReports?: DetectionReport[];
}

/**
 * Give a plain web page just enough of the extension messaging surface for the
 * content-script bundle to run and hand back what it observed. Only the transport is
 * stubbed; the bundle under test is the shipped file, unmodified.
 */
async function stubMessaging(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const target = globalThis as ReportWindow & { chrome?: unknown };
    target.__adlReports = [];
    const noop = (): void => undefined;
    target.chrome = {
      runtime: {
        id: 'e2e-content-probe',
        getManifest: () => ({ manifest_version: 3, version: '0.0.0' }),
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
}

test.describe('AetherDL in Chromium', () => {
  // Serial: one browser profile, one extension install, shared across the journey.
  test.describe.configure({ mode: 'serial' });

  let extension: LoadedExtension;
  let site: FixtureSite;
  let lastReport: DetectionReport | undefined;

  test.beforeAll(async () => {
    site = await startFixtureSite();
    extension = await loadChromiumExtension();
  });

  test.afterAll(async () => {
    await extension.close();
    await site.close();
  });

  test('installs as an MV3 extension with a live background worker', async () => {
    const manifest = await extension.worker.evaluate(() => chrome.runtime.getManifest());

    expect(manifest.manifest_version).toBe(3);
    // `offscreen` is the one Chromium addition: a service worker needs a context
    // that can build a blob URL for an assembled stream (§10.6). It grants no host
    // access and is invisible in the install prompt.
    expect(manifest.permissions).toEqual([
      'storage',
      'downloads',
      'activeTab',
      'scripting',
      'offscreen',
    ]);
    // Still no host permission granted at install: the stream pattern is optional
    // and asked for at point of use (§13.7).
    expect(manifest.host_permissions ?? []).toEqual([]);
    expect(
      (manifest as unknown as { optional_host_permissions?: string[] }).optional_host_permissions,
    ).toEqual(['*://*/*']);
  });

  test('opens the popup and renders a state', async () => {
    const popup = await extension.page('popup.html');

    await expect(popup.locator('.adl-toolbar')).toBeVisible();
    // Nothing has been detected for this tab, so the popup shows its empty state.
    await expect(popup.locator('.adl-status')).toBeVisible();
    await popup.close();
  });

  test('the shipped content script reads real media out of a real page', async () => {
    const page = await extension.context.newPage();
    await stubMessaging(page);
    await page.goto(`${site.origin}/with-media.html`);

    // Run the SHIPPED content-script bundle against a real browser DOM. In the
    // product the background injects this file after the user opens the popup
    // (§8.10); Chromium grants that access only for a genuine toolbar invocation,
    // which automation cannot synthesise, so the file is loaded here directly and
    // its report is carried into the background by the next test.
    await page.addScriptTag({ path: join(distDir('chrome'), 'content.js') });

    const report = await until(
      'the content script to report what it saw',
      () => page.evaluate(() => (globalThis as ReportWindow).__adlReports?.[0]),
      (value) => value !== undefined,
    );

    expect(report?.pageUrl).toBe(`${site.origin}/with-media.html`);
    const seen = [
      ...(report?.domSignals ?? []).map((signal) => signal.src ?? signal.href ?? ''),
      ...(report?.observedUrls ?? []),
    ];
    expect(seen).toContain(`${site.origin}/media/sample.mp4`);
    expect(seen).toContain(`${site.origin}/media/sample.mp3`);
    lastReport = report;

    await page.close();
  });

  test('detects media from that report and badges the tab that owns it', async () => {
    expect(lastReport, 'the content-script report from the previous test').toBeDefined();
    const popup = await extension.page('popup.html');
    await popup.bringToFront();
    const tabId = await extension.worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tab?.id ?? -1;
    });

    // The real `detection/run` message, carrying the real content script's output,
    // through the real bus into the real detection engine (§8.5, §9).
    const items = await sendMessage<readonly MediaItem[]>(popup, {
      type: 'detection/run',
      payload: lastReport,
    });

    expect(items.length).toBeGreaterThan(0);
    expect(items.some((item) => item.url === `${site.origin}/media/sample.mp4`)).toBe(true);
    expect(items.every((item) => item.url.startsWith(site.origin))).toBe(true);

    const badge = await until(
      'the badge to report detected media',
      () => extension.worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId),
      (text) => text !== '',
    );
    expect(Number(badge)).toBe(items.filter((item) => item.status === 'supported').length);

    // A different tab is unaffected: detection state is per tab (§4.1, §4.7).
    const other = await extension.context.newPage();
    await other.goto(`${site.origin}/without-media.html`);
    await other.bringToFront();
    const otherId = await extension.worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tab?.id ?? -1;
    });
    expect(otherId).not.toBe(tabId);
    expect(
      await extension.worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), otherId),
    ).toBe('');

    await other.close();
    await popup.close();
  });

  test('the popup keeps a usable width even when the viewport reports almost none', async () => {
    // Regression: a bare `max-inline-size: 100vw` collapsed the panel to a sliver,
    // because a popup is measured from its own content and the reported viewport can
    // be a few pixels wide before layout. 380px normally; never a sliver.
    const popup = await extension.page('popup.html');
    const width = (): Promise<number> =>
      popup.evaluate(() => document.querySelector('.adl-popup')?.clientWidth ?? 0);

    await popup.setViewportSize({ width: 1280, height: 800 });
    expect(await width()).toBe(380);

    await popup.setViewportSize({ width: 400, height: 600 });
    expect(await width()).toBe(380);

    await popup.setViewportSize({ width: 120, height: 400 });
    expect(await width()).toBeGreaterThanOrEqual(320);

    await popup.close();
  });

  test('downloads a detected file through the native downloads API', async () => {
    const popup = await extension.page('popup.html');
    await popup.bringToFront();

    // Report the fixture page's media for this tab, exactly as the content script
    // does (§8.5 `detection/run`), so the popup shows it and the click is real.
    await sendMessage(popup, {
      type: 'detection/run',
      payload: {
        pageUrl: `${site.origin}/with-media.html`,
        domSignals: [
          {
            role: 'video',
            tagName: 'VIDEO',
            src: `${site.origin}/media/sample.mp4`,
            width: 1280,
            height: 720,
          },
        ],
        observedUrls: [],
      },
    });
    await popup.reload();

    const card = popup.locator('.adl-card').first();
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: /download/i }).click();

    const downloads = await until(
      'the native download to complete',
      () =>
        extension.worker.evaluate(() =>
          chrome.downloads.search({}).then((items) =>
            items.map((item) => ({
              state: item.state,
              bytes: item.bytesReceived,
              url: item.url,
            })),
          ),
        ),
      (items) => items.some((item) => item.state === 'complete'),
    );
    const completed = downloads.find((item) => item.state === 'complete');
    expect(completed?.url).toBe(`${site.origin}/media/sample.mp4`);
    expect(completed?.bytes).toBeGreaterThan(0);

    // The queue — the single source of truth (§4.4) — agrees.
    const queue = await sendMessage<readonly DownloadTask[]>(popup, { type: 'download/query' });
    expect(queue.some((task) => task.state === 'completed')).toBe(true);

    // And the completed transfer lands in local history, which is written to
    // IndexedDB asynchronously (§4.11, §8.14).
    const history = await until(
      'the completed transfer to reach local history',
      () => sendMessage<readonly HistoryRecord[]>(popup, { type: 'history/query' }),
      (records) => records.length > 0,
    );
    expect(history[0]?.outcome).toBe('completed');
    expect(history[0]?.originHost).toBe(new URL(site.origin).host);

    await popup.close();
  });

  test('persists a settings change across a reload', async () => {
    const settings = await extension.page('settings.html');
    const toggle = settings.getByRole('checkbox', { name: /duplicate/i });
    const before = await toggle.isChecked();

    await toggle.click();
    await until(
      'the setting to be applied',
      () => sendMessage<Settings>(settings, { type: 'settings/get' }),
      (applied) => applied.duplicateWarnings === !before,
    );

    await settings.reload();
    // Real storage.local, read back by a freshly mounted page (§4.9).
    await expect(settings.getByRole('checkbox', { name: /duplicate/i })).toBeChecked({
      checked: !before,
    });

    await settings.close();
  });

  test('makes no network request outside the fixture origin', async () => {
    const page = await extension.context.newPage();
    const foreign: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith(site.origin) && !url.startsWith('chrome-extension://')) {
        foreign.push(url);
      }
    });

    await page.goto(`${site.origin}/with-media.html`);
    await page.bringToFront();
    await extension.worker.evaluate(() => chrome.action.openPopup());
    await page.waitForTimeout(1500);

    // Zero egress, observed in a real browser (§14.3).
    expect(foreign).toEqual([]);
    await page.close();
  });
});
