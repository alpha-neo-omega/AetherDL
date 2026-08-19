/**
 * Manual matrix — Firefox, executed (docs/MANUAL_TEST_MATRIX.md, PROJECT_BIBLE.md
 * §16.7). Every case runs against the REAL `dist/firefox` build installed in a REAL
 * Firefox over Marionette (tests/e2e/_fixtures/firefox.ts).
 *
 * Cases already covered by tests/e2e/firefox.spec.ts (install, popup, detection,
 * badge, native download, history, settings persistence, context-menu absence) are
 * not repeated here. Cases no automation can perform — screen reader, toolbar
 * shortcut, OS-level appearance toggles — are recorded as NOT EXECUTED in the matrix
 * document, never as a pass.
 */
import { expect, test } from '@playwright/test';
import { installFirefoxExtension, requestScript, type InstalledFirefox } from './_fixtures/firefox';
import { startFixtureSite, type FixtureSite } from './_fixtures/server';

function record(id: string, expected: string, actual: string): void {
  console.log(`[matrix] firefox | ${id} | expected: ${expected} | actual: ${actual}`);
}

const report = (origin: string, urls: readonly string[], extra: Record<string, unknown> = {}) => ({
  pageUrl: `${origin}/with-media.html`,
  domSignals: urls.map((url) => ({
    role: 'video',
    tagName: 'VIDEO',
    src: url,
    width: 1280,
    height: 720,
    ...extra,
  })),
  observedUrls: [],
});

interface QueuedTask {
  readonly id: string;
  readonly state: string;
  readonly filename: string;
  readonly error?: { readonly code: string };
}

test.describe('manual matrix — Firefox', () => {
  // Not serial: a failing case must not prevent the rest of the matrix running.
  let firefox: InstalledFirefox;
  let site: FixtureSite;

  test.beforeAll(async () => {
    site = await startFixtureSite();
    firefox = await installFirefoxExtension();
  });

  test.afterAll(async () => {
    await firefox.close();
    await site.close();
  });

  const queue = (): Promise<QueuedTask[]> =>
    firefox.asyncScript<QueuedTask[]>(requestScript('download/query', undefined));

  /**
   * Report media for the active tab and enqueue it. Detection state lives in the
   * background's memory (§9.9) and Firefox's event page may be torn down between two
   * messages, which empties it — so the pair is retried once rather than being read
   * as a queue failure.
   */
  async function detectAndEnqueue(
    urls: readonly string[],
    extra: Record<string, unknown> = {},
  ): Promise<{ items: { id: string; status: string }[]; queued: QueuedTask[] }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await firefox.open('popup.html');
      const items = await firefox.asyncScript<{ id: string; status: string }[]>(
        requestScript('detection/run', report(site.origin, urls, extra)),
      );
      if (items.length === 0) {
        continue;
      }
      await firefox.asyncScript(
        requestScript('download/enqueue', { itemIds: items.map((item) => item.id) }),
      );
      const queued = await queue();
      if (queued.length > 0) {
        return { items, queued };
      }
    }
    throw new Error('the background accepted no jobs for the reported media');
  }

  test('M3 — a page with no media shows the empty state', async () => {
    await firefox.open('popup.html');
    await firefox.until(
      'the popup to settle',
      () => firefox.script<string>('return document.body.innerText;'),
      (text) => !text.includes('Reading what this tab'),
    );
    const state = await firefox.script<{ cards: number; text: string }>(
      'return { cards: document.querySelectorAll(".adl-card").length, text: document.body.innerText };',
    );

    record(
      'M3 no media',
      'empty state, no media cards',
      `cards=${String(state.cards)}, text="${state.text.replace(/\n/g, ' ').slice(0, 60)}"`,
    );
    expect(state.cards).toBe(0);
  });

  test('M6 — DRM-protected media is refused', async () => {
    await firefox.open('popup.html');
    const before = await firefox.asyncScript<number>(
      'const found = await browser.downloads.search({}); return found.length;',
    );
    const { items } = await detectAndEnqueue([`${site.origin}/media/sample.mp4`], {
      encrypted: true,
    });
    const unsupported = items.filter((item) => item.status === 'unsupported');
    expect(unsupported.length).toBeGreaterThan(0);

    const settled = await firefox.until('the refusal to settle', queue, (tasks) =>
      tasks.every((task) => task.state !== 'queued' && task.state !== 'active'),
    );
    const after = await firefox.asyncScript<number>(
      'const found = await browser.downloads.search({}); return found.length;',
    );

    record(
      'M6 DRM refusal',
      'refused with a reason; no native download',
      `job=${String(settled[0]?.state)}/${String(settled[0]?.error?.code)}; nativeDownloads ${String(before)}→${String(after)}`,
    );
    expect(after).toBe(before);
    await firefox.asyncScript(requestScript('download/clear', undefined));
  });

  test('M8/M9 — pause, resume and cancel a running download', async () => {
    await detectAndEnqueue([`${site.origin}/media/slow.mp4?ff`]);
    const running = await firefox.until('the download to start', queue, (tasks) =>
      tasks.some((task) => task.state === 'active'),
    );
    const id = running.find((task) => task.state === 'active')?.id ?? '';

    await firefox.asyncScript(requestScript('download/pause', { taskId: id }));
    const paused = await firefox.until('the download to pause', queue, (tasks) =>
      tasks.some((task) => task.state === 'paused'),
    );
    record('M8 pause', 'the job reports paused', `states=${paused.map((t) => t.state).join(',')}`);

    await firefox.asyncScript(requestScript('download/resume', { taskId: id }));
    const resumed = await firefox.until('the download to resume', queue, (tasks) =>
      tasks.some((task) => task.state === 'active' || task.state === 'completed'),
    );
    record('M8 resume', 'the job runs again', `states=${resumed.map((t) => t.state).join(',')}`);

    await firefox.asyncScript(requestScript('download/cancel', { taskId: id }));
    const cancelled = await firefox.until('the download to cancel', queue, (tasks) =>
      tasks.every((task) => task.state !== 'active'),
    );
    record(
      'M9 cancel',
      'the job leaves the active set',
      `states=${cancelled.map((t) => t.state).join(',')}`,
    );
    expect(cancelled.some((task) => task.state === 'active')).toBe(false);
    await firefox.asyncScript(requestScript('download/clear', undefined));
  });

  test('M11 — the configured filename template and subfolder decide the file on disk', async () => {
    // Verified here rather than in Chromium: Playwright intercepts downloads in its
    // persistent context and rewrites their path to its own artifacts directory, so the
    // browser's real destination is only observable in the Marionette-driven Firefox.
    await firefox.open('popup.html');
    await firefox.asyncScript(
      requestScript('settings/update', {
        filenameTemplate: '{host}-{title}.{ext}',
        downloadSubfolder: 'AetherDL/Clips',
      }),
    );
    await detectAndEnqueue([`${site.origin}/media/sample.mp4`]);

    const written = await firefox.until(
      'the configured file to be written',
      () =>
        firefox.asyncScript<string[]>(
          'const found = await browser.downloads.search({}); return found.filter((item) => item.state === "complete").map((item) => String(item.filename).split("\\\\").join("/"));',
        ),
      (paths) => paths.some((path) => path.includes('/AetherDL/Clips/')),
    );
    const path = written.find((candidate) => candidate.includes('/AetherDL/Clips/')) ?? '';

    record(
      'M11 filename template and subfolder',
      'the browser writes <subfolder>/<template>, one extension only',
      `path tail=${path.split('/').slice(-3).join('/')}`,
    );
    // {host}-{title}.{ext} under the configured folder, and `sample.mp4` not `sample.mp4.mp4`.
    expect(path).toMatch(/\/AetherDL\/Clips\/127\.0\.0\.1[^/]*-sample\.mp4$/);

    await firefox.asyncScript(
      requestScript('settings/update', {
        filenameTemplate: '{title}.{ext}',
        downloadSubfolder: '',
      }),
    );
    await firefox.asyncScript(requestScript('download/clear', undefined));
  });

  test('M14 — the theme setting repaints the surface', async () => {
    const surface = (): Promise<string> =>
      firefox.script<string>(
        'return getComputedStyle(document.documentElement).getPropertyValue("--adl-color-surface").trim();',
      );

    await firefox.open('settings.html');
    await firefox.asyncScript(requestScript('settings/update', { theme: 'light' }));
    await firefox.open('settings.html');
    const light = await firefox.until('the light theme to apply', surface, (value) => value !== '');

    await firefox.asyncScript(requestScript('settings/update', { theme: 'dark' }));
    await firefox.open('settings.html');
    const dark = await firefox.until(
      'the dark theme to apply',
      surface,
      (value) => value !== '' && value !== light,
    );

    record('M14 theme', 'dark and light paint different surfaces', `light=${light}, dark=${dark}`);
    expect(dark).not.toBe(light);
    await firefox.asyncScript(requestScript('settings/update', { theme: 'system' }));
  });

  test('M15 — the reduced-motion setting suppresses animation', async () => {
    // The setting is applied from an extension page: that is where the bus lives.
    await firefox.open('settings.html');
    await firefox.asyncScript(requestScript('settings/update', { reducedMotion: 'on' }));
    await firefox.open('settings.html');
    const state = await firefox.until(
      'the preference to apply',
      () =>
        firefox.script<{ flag: string; perceptible: number }>(
          `return {
             flag: String(document.documentElement.dataset.reducedMotion),
             perceptible: [...document.querySelectorAll('*')]
               .flatMap((node) => [getComputedStyle(node).transitionDuration, getComputedStyle(node).animationDuration])
               .flatMap((value) => value.split(',').map((part) => part.trim()))
               .filter((value) => value !== '')
               .filter((value) => (value.endsWith('ms') ? parseFloat(value) : parseFloat(value) * 1000) >= 10).length,
           };`,
        ),
      (value) => value.flag === 'true',
    );

    record(
      'M15 reduced motion',
      'no perceptible animation remains',
      `data-reduced-motion=${state.flag}, durations >= 10ms: ${String(state.perceptible)}`,
    );
    expect(state.perceptible).toBe(0);
    await firefox.asyncScript(requestScript('settings/update', { reducedMotion: 'system' }));
  });

  test('M16 — every control is keyboard reachable and named', async () => {
    await firefox.open('settings.html');
    await firefox.until(
      'the settings page to mount',
      () => firefox.script<string>('return document.body.innerText;'),
      (text) => !text.includes('Loading settings'),
    );
    const audit = await firefox.script<{
      total: number;
      unreachable: number;
      unnamed: number;
      disabled: number;
    }>(
      `const controls = [...document.querySelectorAll('button, input, select, textarea, a[href]')];
       const named = (node) => (node.getAttribute('aria-label') || node.textContent || '').trim() !== ''
         || (node.labels && node.labels.length > 0)
         || (node.getAttribute('aria-labelledby') || '') !== '';
       return {
         total: controls.length,
         // A disabled control is legitimately not focusable; only an ENABLED control
         // removed from the tab order is a keyboard defect.
         unreachable: controls.filter((node) => !node.disabled && node.tabIndex < 0).length,
         disabled: controls.filter((node) => node.disabled).length,
         unnamed: controls.filter((node) => !named(node)).length,
       };`,
    );

    record(
      'M16 keyboard reachability (structural)',
      'no control is removed from the tab order or unnamed',
      `controls=${String(audit.total)}, unreachable=${String(audit.unreachable)}, ` +
        `unnamed=${String(audit.unnamed)}, disabled=${String(audit.disabled)}`,
    );
    expect(audit.total).toBeGreaterThan(5);
    expect(audit.unreachable).toBe(0);
    expect(audit.unnamed).toBe(0);
  });

  test('M7 — the queue respects the configured concurrency limit', async () => {
    await firefox.open('popup.html');
    await firefox.asyncScript(requestScript('settings/update', { maxConcurrentDownloads: 2 }));
    const { items } = await detectAndEnqueue([
      `${site.origin}/media/slow.mp4?1`,
      `${site.origin}/media/slow.mp4?2`,
      `${site.origin}/media/slow.mp4?3`,
      `${site.origin}/media/slow.mp4?4`,
    ]);
    expect(items.length, 'the four fixture videos must be detected').toBe(4);
    const started = await firefox.until('downloads to start', queue, (tasks) =>
      tasks.some((task) => task.state === 'active'),
    );
    const active = started.filter((task) => task.state === 'active').length;

    record(
      'M7 queue concurrency',
      'at most 2 active, the rest queued',
      `active=${String(active)}, total=${String(started.length)}`,
    );
    for (const task of started) {
      await firefox.asyncScript(requestScript('download/cancel', { taskId: task.id }));
    }
    await firefox.asyncScript(requestScript('download/clear', undefined));
    await firefox.asyncScript(requestScript('settings/update', { maxConcurrentDownloads: 3 }));
    expect(active).toBeLessThanOrEqual(2);
  });
});
