/**
 * Manual matrix — Chromium, executed (docs/MANUAL_TEST_MATRIX.md, PROJECT_BIBLE.md
 * §16.7). Every case here runs against the REAL unpacked build in a REAL Chromium.
 *
 * Each test logs a `[matrix]` row with the observed value, so the recorded result is
 * what the browser actually did rather than a restatement of the assertion. Cases
 * that no automation can perform (toolbar shortcut, screen reader, other Chromium
 * distributions) are recorded as NOT EXECUTED in the matrix document, never as a
 * pass.
 */
import { expect, test } from '@playwright/test';
import type { DownloadTask, HistoryRecord, MediaItem, Settings } from '../../src/shared/types';
import {
  loadChromiumExtension,
  sendMessage,
  until,
  type LoadedExtension,
} from './_fixtures/extension';
import { startFixtureSite, type FixtureSite } from './_fixtures/server';

/** Record one matrix row with the value the browser actually produced. */
function record(id: string, expected: string, actual: string): void {
  console.log(`[matrix] chromium | ${id} | expected: ${expected} | actual: ${actual}`);
}

const signal = (url: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  role: 'video',
  tagName: 'VIDEO',
  src: url,
  width: 1280,
  height: 720,
  ...extra,
});

test.describe('manual matrix — Chromium', () => {
  // Deliberately NOT serial: a failing case must not skip the cases after it — the
  // matrix has to be executed in full, and a failure is a recorded result (§16.7).

  let extension: LoadedExtension;
  let site: FixtureSite;

  test.beforeAll(async () => {
    site = await startFixtureSite();
    extension = await loadChromiumExtension();
  });

  test.afterAll(async () => {
    await extension.close();
    await site.close();
  });

  /**
   * Wait until no native transfer is still running. The fixture's slow route holds a
   * socket open, and Chromium allows only a handful of connections per host, so a
   * later case's request can queue behind an abandoned one — cancelled jobs have to be
   * off the wire before the next case starts.
   */
  async function settleNativeDownloads(): Promise<void> {
    await until(
      'the browser to have no transfer in flight',
      () =>
        extension.worker.evaluate(() =>
          chrome.downloads
            .search({})
            .then((found) => found.filter((item) => item.state === 'in_progress').length),
        ),
      (running) => running === 0,
    );
  }

  /** A popup page with the tab's media already reported, ready to act on. */
  async function popupWithMedia(urls: readonly string[], extra: Record<string, unknown> = {}) {
    const popup = await extension.page('popup.html');
    await popup.bringToFront();
    const items = await sendMessage<readonly MediaItem[]>(popup, {
      type: 'detection/run',
      payload: {
        pageUrl: `${site.origin}/with-media.html`,
        domSignals: urls.map((url) => signal(url, extra)),
        observedUrls: [],
      },
    });
    return { popup, items };
  }

  test('M6 — DRM-protected media is refused, never downloaded', async () => {
    const { popup, items } = await popupWithMedia([`${site.origin}/media/sample.mp4`], {
      encrypted: true,
    });

    const unsupported = items.filter((item) => item.status === 'unsupported');
    expect(unsupported.length).toBeGreaterThan(0);
    const before = await extension.worker.evaluate(() =>
      chrome.downloads.search({}).then((found) => found.length),
    );

    await sendMessage(popup, {
      type: 'download/enqueue',
      payload: { itemIds: [unsupported[0]?.id ?? ''] },
    });
    const queue = await until(
      'the refusal to settle',
      () => sendMessage<readonly DownloadTask[]>(popup, { type: 'download/query' }),
      (tasks) => tasks.every((task) => task.state !== 'queued' && task.state !== 'active'),
    );
    const after = await extension.worker.evaluate(() =>
      chrome.downloads.search({}).then((found) => found.length),
    );
    const refused = queue[0];

    record(
      'M6 DRM refusal',
      'listed as unsupported with a reason; the job is refused and no native download starts',
      `status=${String(unsupported[0]?.status)}; reason="${String(unsupported[0]?.unsupportedReason).slice(0, 40)}"; job=${String(refused?.state)}/${String(refused?.error?.code)}; nativeDownloads ${String(before)}→${String(after)}`,
    );
    expect(refused?.state).toBe('failed');
    expect(after).toBe(before);
    await sendMessage(popup, { type: 'download/clear' });
    await popup.close();
  });

  test('M7 — the queue respects the concurrency limit', async () => {
    const { popup, items } = await popupWithMedia([
      `${site.origin}/media/slow.mp4?a`,
      `${site.origin}/media/slow.mp4?b`,
      `${site.origin}/media/slow.mp4?c`,
      `${site.origin}/media/slow.mp4?d`,
    ]);
    await sendMessage<Settings>(popup, {
      type: 'settings/update',
      payload: { maxConcurrentDownloads: 2 },
    });

    await sendMessage(popup, {
      type: 'download/enqueue',
      payload: { itemIds: items.map((item) => item.id) },
    });
    const states = await until(
      'downloads to start',
      () => sendMessage<readonly DownloadTask[]>(popup, { type: 'download/query' }),
      (queue) => queue.some((task) => task.state === 'active'),
    );
    const active = states.filter((task) => task.state === 'active').length;
    const queued = states.filter((task) => task.state === 'queued').length;

    record(
      'M7 queue concurrency',
      'at most 2 active, the rest queued',
      `active=${String(active)}, queued=${String(queued)}, total=${String(states.length)}`,
    );
    expect(active).toBeLessThanOrEqual(2);
    expect(states.length).toBe(4);

    // Leave the browser idle for the next case.
    for (const task of states) {
      await sendMessage(popup, { type: 'download/cancel', payload: { taskId: task.id } });
    }
    await settleNativeDownloads();
    await sendMessage(popup, { type: 'download/clear' });
    await popup.close();
  });

  test('M8/M9 — pause, resume and cancel a running download', async () => {
    const { popup, items } = await popupWithMedia([`${site.origin}/media/slow.mp4?pause`]);
    await sendMessage<Settings>(popup, {
      type: 'settings/update',
      payload: { maxConcurrentDownloads: 3 },
    });
    const id = items[0]?.id ?? '';
    await sendMessage(popup, { type: 'download/enqueue', payload: { itemIds: [id] } });

    const running = await until(
      'the download to start',
      () => sendMessage<readonly DownloadTask[]>(popup, { type: 'download/query' }),
      (queue) => queue.some((task) => task.state === 'active'),
    );
    const task = running.find((entry) => entry.state === 'active');
    expect(task).toBeDefined();

    await sendMessage(popup, { type: 'download/pause', payload: { taskId: task?.id ?? '' } });
    const paused = await until(
      'the download to pause',
      () => sendMessage<readonly DownloadTask[]>(popup, { type: 'download/query' }),
      (queue) => queue.some((entry) => entry.state === 'paused'),
    );
    record(
      'M8 pause',
      'the job reports paused',
      `states=${paused.map((entry) => entry.state).join(',')}`,
    );

    await sendMessage(popup, { type: 'download/resume', payload: { taskId: task?.id ?? '' } });
    const resumed = await until(
      'the download to resume',
      () => sendMessage<readonly DownloadTask[]>(popup, { type: 'download/query' }),
      (queue) => queue.some((entry) => entry.state === 'active' || entry.state === 'completed'),
    );
    record(
      'M8 resume',
      'the job runs again',
      `states=${resumed.map((entry) => entry.state).join(',')}`,
    );

    await sendMessage(popup, { type: 'download/cancel', payload: { taskId: task?.id ?? '' } });
    const cancelled = await until(
      'the download to cancel',
      () => sendMessage<readonly DownloadTask[]>(popup, { type: 'download/query' }),
      (queue) => queue.every((entry) => entry.state !== 'active'),
    );
    record(
      'M9 cancel',
      'the job leaves the active set',
      `states=${cancelled.map((entry) => entry.state).join(',')}`,
    );
    expect(cancelled.some((entry) => entry.state === 'active')).toBe(false);

    await settleNativeDownloads();
    await sendMessage(popup, { type: 'download/clear' });
    await popup.close();
  });

  test('M10 — a failing transfer fails cleanly and can be retried', async () => {
    const { popup, items } = await popupWithMedia([`${site.origin}/media/missing.mp4`]);
    await sendMessage<Settings>(popup, { type: 'settings/update', payload: { maxRetries: 0 } });
    const id = items[0]?.id ?? '';

    await sendMessage(popup, { type: 'download/enqueue', payload: { itemIds: [id] } });
    const failed = await until(
      'the transfer to fail',
      () => sendMessage<readonly DownloadTask[]>(popup, { type: 'download/query' }),
      (queue) => queue.some((task) => task.state === 'failed'),
    );
    const task = failed.find((entry) => entry.state === 'failed');
    record(
      'M10 retry (failure)',
      'the job reports failed with a reason, nothing silently lost',
      `state=${String(task?.state)}, error=${String(task?.error?.code)}`,
    );

    record(
      'M10 retry (automatic)',
      'the configured retry limit is honoured',
      `attempts observed=${String(task?.attempt)} with maxRetries=0`,
    );

    const nativeBefore = await extension.worker.evaluate(() =>
      chrome.downloads.search({}).then((found) => found.length),
    );
    await sendMessage(popup, { type: 'download/retry', payload: { taskId: task?.id ?? '' } });
    const nativeAfter = await until(
      'the retry to reach the browser',
      () =>
        extension.worker.evaluate(() => chrome.downloads.search({}).then((found) => found.length)),
      (count) => count > nativeBefore,
    );
    record(
      'M10 retry (manual)',
      'a manual retry starts a fresh transfer',
      `native downloads ${String(nativeBefore)}→${String(nativeAfter)}`,
    );

    await sendMessage<Settings>(popup, { type: 'settings/update', payload: { maxRetries: 3 } });
    await sendMessage(popup, { type: 'download/clear' });
    await popup.close();
  });

  test('M12/M13 — history records, exports, deletes, clears, and can be turned off', async () => {
    const { popup, items } = await popupWithMedia([`${site.origin}/media/sample.mp4?history`]);
    await sendMessage<Settings>(popup, { type: 'settings/update', payload: { keepHistory: true } });
    await sendMessage(popup, {
      type: 'download/enqueue',
      payload: { itemIds: [items[0]?.id ?? ''] },
    });
    await until(
      'the transfer to complete',
      () => sendMessage<readonly DownloadTask[]>(popup, { type: 'download/query' }),
      (queue) => queue.some((task) => task.state === 'completed'),
    );
    const recorded = await until(
      'history to hold the earlier completed transfer',
      () => sendMessage<readonly HistoryRecord[]>(popup, { type: 'history/query' }),
      (records) => records.length > 0,
    );
    const exported = await sendMessage<string>(popup, { type: 'history/export' });
    record(
      'M12 history',
      'records listed and exportable as local JSON',
      `records=${String(recorded.length)}, exportBytes=${String(exported.length)}`,
    );
    expect(JSON.parse(exported)).toMatchObject({ records: expect.any(Array) as unknown[] });

    await sendMessage(popup, { type: 'history/delete', payload: { id: recorded[0]?.id ?? '' } });
    const afterDelete = await sendMessage<readonly HistoryRecord[]>(popup, {
      type: 'history/query',
    });
    await sendMessage(popup, { type: 'history/clear' });
    const afterClear = await sendMessage<readonly HistoryRecord[]>(popup, {
      type: 'history/query',
    });
    record(
      'M12 history delete/clear',
      'one record removed, then the list emptied',
      `afterDelete=${String(afterDelete.length)}, afterClear=${String(afterClear.length)}`,
    );
    expect(afterClear).toEqual([]);

    await sendMessage<Settings>(popup, {
      type: 'settings/update',
      payload: { keepHistory: false },
    });
    const { popup: second, items: silentItems } = await popupWithMedia([
      `${site.origin}/media/sample.mp4?silent`,
    ]);
    await sendMessage(second, {
      type: 'download/enqueue',
      payload: { itemIds: [silentItems[0]?.id ?? ''] },
    });
    await until(
      'the transfer to finish',
      () => sendMessage<readonly DownloadTask[]>(second, { type: 'download/query' }),
      (queue) => queue.some((task) => task.state === 'completed'),
    );
    const withHistoryOff = await sendMessage<readonly HistoryRecord[]>(second, {
      type: 'history/query',
    });
    record(
      'M13 history off',
      'nothing new is recorded',
      `records=${String(withHistoryOff.length)}`,
    );
    expect(withHistoryOff).toEqual([]);

    await sendMessage<Settings>(second, {
      type: 'settings/update',
      payload: { keepHistory: true },
    });
    await sendMessage(second, { type: 'download/clear' });
    await second.close();
    await popup.close();
  });

  test('M14 — the popup follows the theme setting and the OS scheme', async () => {
    const popup = await extension.page('popup.html');
    await sendMessage<Settings>(popup, { type: 'settings/update', payload: { theme: 'system' } });

    await popup.emulateMedia({ colorScheme: 'dark' });
    await popup.reload();
    const dark = await popup
      .locator('.adl-theme, [data-adl-theme], body')
      .first()
      .evaluate((node) => getComputedStyle(node).backgroundColor);
    await popup.emulateMedia({ colorScheme: 'light' });
    await popup.reload();
    const light = await popup
      .locator('.adl-theme, [data-adl-theme], body')
      .first()
      .evaluate((node) => getComputedStyle(node).backgroundColor);

    record('M14 theme', 'dark and light render different surfaces', `dark=${dark}, light=${light}`);
    expect(dark).not.toBe(light);
    await popup.close();
  });

  test('M15 — reduced motion is honoured', async () => {
    const popup = await extension.page('popup.html');
    await popup.emulateMedia({ reducedMotion: 'reduce' });
    await popup.reload();
    const durations = await popup.evaluate(() =>
      [...document.querySelectorAll('*')]
        .flatMap((node) => {
          const style = getComputedStyle(node);
          return [style.transitionDuration, style.animationDuration];
        })
        .flatMap((value) => value.split(',').map((part) => part.trim()))
        .filter((value) => value !== '')
        // Anything at or above 10ms would be perceptible motion.
        .filter(
          (value) =>
            (value.endsWith('ms') ? Number.parseFloat(value) : Number.parseFloat(value) * 1000) >=
            10,
        ),
    );

    record(
      'M15 reduced motion',
      'no element animates perceptibly',
      `durations >= 10ms: ${String(durations.length)}`,
    );
    expect(durations).toEqual([]);
    await popup.close();
  });

  test('M16 — the popup is operable with the keyboard alone', async () => {
    const { popup } = await popupWithMedia([`${site.origin}/media/sample.mp4`]);
    await popup.reload();
    await popup.locator('.adl-card').first().waitFor();

    const reached: string[] = [];
    for (let step = 0; step < 12; step += 1) {
      await popup.keyboard.press('Tab');
      reached.push(
        await popup.evaluate(() => {
          const active = document.activeElement;
          return active === null
            ? 'none'
            : `${active.tagName}:${active.getAttribute('aria-label') ?? active.textContent?.trim().slice(0, 24) ?? ''}`;
        }),
      );
    }
    const focusVisible = await popup.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return active !== null && getComputedStyle(active).outlineStyle !== 'none';
    });

    record(
      'M16 keyboard only',
      'every control reachable by Tab with a visible focus ring',
      `distinct stops=${String(new Set(reached).size)}, focusRing=${String(focusVisible)}`,
    );
    expect(new Set(reached).size).toBeGreaterThan(4);
    expect(reached.includes('none')).toBe(false);
    await popup.close();
  });

  test('M18/M19/M20 — optional permissions are requested from a gesture and revocable', async () => {
    const settings = await extension.page('settings.html');
    await settings.bringToFront();

    const outcome = await settings.evaluate(async () => {
      // A real click is the user gesture Chromium requires (§13.3). Whether the
      // prompt can then be ANSWERED is a browser-UI question automation cannot
      // reach, so the request is raced against a timeout rather than hung on.
      const button = document.createElement('button');
      button.id = 'adl-e2e-grant';
      document.body.append(button);
      const asked = new Promise<string>((resolve) => {
        button.addEventListener('click', () => {
          void chrome.permissions
            .request({ permissions: ['contextMenus'] })
            .then((granted) => resolve(granted ? 'granted' : 'refused'))
            .catch((error: unknown) => resolve(`error: ${String(error)}`));
        });
        button.click();
      });
      const timeout = new Promise<string>((resolve) => {
        setTimeout(() => resolve('prompt unanswered'), 5000);
      });
      return Promise.race([asked, timeout]);
    });

    record(
      'M18/M19 optional permissions (request)',
      'the request reaches the browser from a user gesture',
      `outcome=${outcome} (a headless browser has no one to answer the prompt)`,
    );

    const state = await settings.evaluate(async () => {
      await chrome.permissions.remove({ permissions: ['contextMenus', 'notifications'] });
      const current = await chrome.permissions.getAll();
      return (current.permissions ?? []).filter(
        (name) => name === 'contextMenus' || name === 'notifications',
      );
    });
    record(
      'M20 permission revoke',
      'no optional permission is left granted',
      `remaining optional=${state.join(',') || 'none'}`,
    );
    expect(state).toEqual([]);
    await settings.close();
  });
});
