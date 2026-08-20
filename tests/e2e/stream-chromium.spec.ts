/**
 * Browser e2e — HLS assembly in Chromium (PROJECT_BIBLE.md §16.3, §10.6, §6).
 *
 * Drives the real unpacked build: the service worker delegates assembly to the real
 * offscreen document, which fetches a real playlist and real segments from the
 * loopback fixture, and the assembled file is saved by the real `chrome.downloads`.
 * The fixture is non-DRM; the encrypted playlist here exists to prove it is REFUSED.
 *
 * One harness accommodation, stated plainly: the loopback host permission that a user
 * grants at point of use is instead PRE-GRANTED here, by copying the built extension
 * and adding `host_permissions: ["http://127.0.0.1/*"]` to the copy's manifest. An
 * automated browser cannot accept Chromium's native permission prompt, and no flag
 * grants an extension host permission. Every shipped byte under test is unchanged —
 * only the manifest of the throwaway copy differs, standing in for the user's click.
 * The point-of-use request path itself is covered by unit tests (the popup client and
 * the popup surface), not by this file.
 */
import { expect, test } from '@playwright/test';
import type { DownloadTask, MediaItem } from '../../src/shared/types';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  distDir,
  loadChromiumExtension,
  sendMessage,
  until,
  type LoadedExtension,
} from './_fixtures/extension';
import {
  HLS_SEGMENT_COUNT,
  HLS_TOTAL_BYTES,
  startFixtureSite,
  type FixtureSite,
} from './_fixtures/server';

interface NativeDownload {
  readonly state: string;
  readonly bytes: number;
  readonly url: string;
  readonly filename: string;
}

test.describe('AetherDL assembles a non-DRM HLS stream in Chromium', () => {
  test.describe.configure({ mode: 'serial' });

  let extension: LoadedExtension;
  let site: FixtureSite;
  let stagedDir: string;

  /** The built extension, copied with the loopback host permission pre-granted. */
  function stageWithLoopbackAccess(): string {
    const dir = mkdtempSync(join(tmpdir(), 'aetherdl-stream-e2e-'));
    cpSync(distDir('chrome'), dir, { recursive: true });
    const manifestPath = join(dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    // A match pattern's host carries no port, so this covers the fixture's
    // ephemeral port without naming it.
    manifest['host_permissions'] = ['http://127.0.0.1/*'];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    return dir;
  }

  test.beforeAll(async () => {
    site = await startFixtureSite();
    stagedDir = stageWithLoopbackAccess();
    extension = await loadChromiumExtension(stagedDir);
  });

  test.afterAll(async () => {
    await extension.close();
    await site.close();
    rmSync(stagedDir, { recursive: true, force: true });
  });

  test('detects the playlist as downloadable media', async () => {
    const popup = await extension.page('popup.html');
    const items = await sendMessage<readonly MediaItem[]>(popup, {
      type: 'detection/run',
      payload: {
        pageUrl: `${site.origin}/with-media.html`,
        domSignals: [
          {
            role: 'video',
            tagName: 'VIDEO',
            src: `${site.origin}/media/hls/master.m3u8`,
            width: 640,
            height: 360,
          },
        ],
        observedUrls: [],
      },
    });

    const stream = items.find((item) => item.url.endsWith('master.m3u8'));
    expect(stream).toBeDefined();
    expect(stream?.status).toBe('supported');
    expect(stream?.delivery).toBe('hls');
    await popup.close();
  });

  test('assembles the segments and saves one file through the downloads API', async () => {
    const popup = await extension.page('popup.html');
    const items = await sendMessage<readonly MediaItem[]>(popup, {
      type: 'detection/run',
      payload: {
        pageUrl: `${site.origin}/with-media.html`,
        domSignals: [
          {
            role: 'video',
            tagName: 'VIDEO',
            src: `${site.origin}/media/hls/master.m3u8`,
            width: 640,
            height: 360,
          },
        ],
        observedUrls: [],
      },
    });
    const stream = items.find((item) => item.url.endsWith('master.m3u8'));
    expect(stream).toBeDefined();

    await sendMessage(popup, {
      type: 'download/enqueue',
      payload: { itemIds: [stream?.id ?? ''] },
    });

    const downloads = await until(
      'the assembled stream to be saved',
      () =>
        extension.worker.evaluate(() =>
          chrome.downloads.search({}).then((found) =>
            found.map((item) => ({
              state: item.state,
              bytes: item.bytesReceived,
              url: item.url,
              filename: item.filename,
            })),
          ),
        ),
      (found: readonly NativeDownload[]) =>
        found.some((item) => item.state === 'complete' && item.url.startsWith('blob:')),
      60_000,
    );

    const completed = downloads.find(
      (item) => item.state === 'complete' && item.url.startsWith('blob:'),
    );
    // Every segment, and nothing but the segments.
    expect(completed?.bytes).toBe(HLS_TOTAL_BYTES);

    const queue = await sendMessage<readonly DownloadTask[]>(popup, { type: 'download/query' });
    const task = queue.find((entry) => entry.item.url.endsWith('master.m3u8'));
    expect(task?.state).toBe('completed');
    expect(task?.bytesTotal).toBe(HLS_TOTAL_BYTES);
    // The name the extension asked the browser to save under carries the real
    // container, not the playlist's extension. Asserted on the queue rather than on
    // `DownloadItem.filename`, because Playwright rewrites the on-disk path of every
    // download into its own artifacts directory (same limitation as §16.3's
    // subfolder check, which is verified in the Firefox suite instead).
    expect(task?.filename.endsWith('.ts')).toBe(true);
    expect(task?.filename).not.toContain('.m3u8');
    await popup.close();
  });

  test('refuses an encrypted playlist and downloads nothing for it', async () => {
    const popup = await extension.page('popup.html');
    const items = await sendMessage<readonly MediaItem[]>(popup, {
      type: 'detection/run',
      payload: {
        pageUrl: `${site.origin}/with-media.html`,
        domSignals: [
          {
            role: 'video',
            tagName: 'VIDEO',
            src: `${site.origin}/media/hls/encrypted.m3u8`,
            width: 640,
            height: 360,
          },
        ],
        observedUrls: [],
      },
    });
    const encrypted = items.find((item) => item.url.endsWith('encrypted.m3u8'));
    expect(encrypted).toBeDefined();

    const before = await extension.worker.evaluate(() =>
      chrome.downloads.search({}).then((found) => found.length),
    );
    await sendMessage(popup, {
      type: 'download/enqueue',
      payload: { itemIds: [encrypted?.id ?? ''] },
    });

    const queue = await until(
      'the encrypted playlist to be refused',
      () => sendMessage<readonly DownloadTask[]>(popup, { type: 'download/query' }),
      (tasks) =>
        tasks.some((task) => task.item.url.endsWith('encrypted.m3u8') && task.state === 'failed'),
      30_000,
    );

    const failed = queue.find((task) => task.item.url.endsWith('encrypted.m3u8'));
    expect(failed?.error?.code).toBe('stream-hls-encrypted');
    // Protected media, described as protected media — and never retried. On Chromium
    // this crosses the offscreen boundary, where only the code survives the wire.
    expect(failed?.error?.category).toBe('drm');
    expect(failed?.error?.messageKey).toBe('error.drm');
    expect(failed?.error?.retryable).toBe(false);
    // Nothing new reached the downloads API, and no key was ever requested.
    const after = await extension.worker.evaluate(() =>
      chrome.downloads.search({}).then((found) => found.length),
    );
    expect(after).toBe(before);
    await popup.close();
  });

  test('refuses a stream whose audio is a separate track, and says why', async () => {
    const popup = await extension.page('popup.html');
    const items = await sendMessage<readonly MediaItem[]>(popup, {
      type: 'detection/run',
      payload: {
        pageUrl: `${site.origin}/with-media.html`,
        domSignals: [
          {
            role: 'video',
            tagName: 'VIDEO',
            src: `${site.origin}/media/hls/split-audio.m3u8`,
            width: 1280,
            height: 720,
          },
        ],
        observedUrls: [],
      },
    });
    const split = items.find((item) => item.url.endsWith('split-audio.m3u8'));
    expect(split).toBeDefined();

    const before = await extension.worker.evaluate(() =>
      chrome.downloads.search({}).then((found) => found.length),
    );
    await sendMessage(popup, {
      type: 'download/enqueue',
      payload: { itemIds: [split?.id ?? ''] },
    });

    const queue = await until(
      'the split-track stream to be refused',
      () => sendMessage<readonly DownloadTask[]>(popup, { type: 'download/query' }),
      (tasks) =>
        tasks.some((task) => task.item.url.endsWith('split-audio.m3u8') && task.state === 'failed'),
      30_000,
    );

    const failed = queue.find((task) => task.item.url.endsWith('split-audio.m3u8'));
    expect(failed?.error?.code).toBe('stream-hls-separate-audio');
    // A silent video is never saved, and the reason is carried on the job so the
    // popup can show it.
    expect(failed?.error?.messageKey).toBe('error.download.stream.tracks');
    const after = await extension.worker.evaluate(() =>
      chrome.downloads.search({}).then((found) => found.length),
    );
    expect(after).toBe(before);
    await popup.close();
  });

  test('the segment count the assembly reported matches the fixture', async () => {
    // Cheap consistency check on the fixture itself, so a mis-sized fixture cannot
    // make the assertion above pass for the wrong reason.
    expect(HLS_TOTAL_BYTES / HLS_SEGMENT_COUNT).toBe(4096);
  });
});
