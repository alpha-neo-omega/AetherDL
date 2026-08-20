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
import type { DownloadTask, MediaItem, StreamRenditionSnapshot } from '../../src/shared/types';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  muxFragmentedMp4,
  splitFragmentedMp4,
  type Mp4Track,
} from '../../src/core/download/stream/mux';
import { writeFragmentedMp4 } from '../../src/core/download/stream/mp4write';
import { demuxMpegTs, TS_CLOCK_HZ } from '../../src/core/download/stream/ts';
import {
  distDir,
  loadChromiumExtension,
  sendMessage,
  until,
  type LoadedExtension,
} from './_fixtures/extension';
import {
  HLS_LADDER,
  HLS_SEGMENT_COUNT,
  HLS_TOTAL_BYTES,
  ladderTotalBytes,
  SITE_ROOT,
  startFixtureSite,
  type FixtureSite,
} from './_fixtures/server';

interface NativeDownload {
  readonly state: string;
  readonly bytes: number;
  readonly url: string;
  readonly filename: string;
}

/**
 * What the muxer produces from the committed split-track fixtures, computed here so the
 * browser's result is compared against an independent calculation rather than itself.
 */
function expectedMuxedBytes(): number {
  const dir = join(SITE_ROOT, 'media', 'split');
  const read = (name: string): Uint8Array => new Uint8Array(readFileSync(join(dir, name)));
  const track = (prefix: string, fragments: number): ReturnType<typeof splitFragmentedMp4> => {
    const init = splitFragmentedMp4(read(`${prefix}-init.mp4`));
    const parts = Array.from({ length: fragments }, (_unused, index) =>
      splitFragmentedMp4(read(`${prefix}-${String(index + 1)}.m4s`)),
    );
    return { init: init.init, fragments: parts.flatMap((part) => part.fragments) };
  };
  const result = muxFragmentedMp4({ video: track('v', 2), audio: track('a', 2) });
  if (!result.ok) {
    throw result.error;
  }
  return result.value.reduce((sum, part) => sum + part.byteLength, 0);
}

/**
 * What the shipped demuxer and writer produce from the committed MPEG-TS fixtures.
 *
 * Computed here in Node so the browser's result is compared against an independent
 * calculation rather than against itself.
 */
function expectedRemuxedBytes(): number {
  const dir = join(SITE_ROOT, 'media', 'split-ts');
  const readTrack = (prefix: string, kind: 'video' | 'audio'): Mp4Track => {
    const parts = [1, 2].map(
      (index) => new Uint8Array(readFileSync(join(dir, `${prefix}-${String(index)}.m2ts`))),
    );
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const joined = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      joined.set(part, at);
      at += part.byteLength;
    }
    const demuxed = demuxMpegTs(joined);
    if (!demuxed.ok) {
      throw demuxed.error;
    }
    const track = demuxed.value.tracks.find((candidate) => candidate.kind === kind);
    if (track === undefined) {
      throw new Error(`no ${kind} track in the fixture`);
    }
    const written = writeFragmentedMp4(track, {
      trackId: 1,
      originTicks90k: (track.samples[0]?.dts ?? 0) * (TS_CLOCK_HZ / track.timescale),
    });
    if (!written.ok) {
      throw written.error;
    }
    return written.value;
  };
  const result = muxFragmentedMp4({
    video: readTrack('v', 'video'),
    audio: readTrack('a', 'audio'),
  });
  if (!result.ok) {
    throw result.error;
  }
  return result.value.reduce((sum, part) => sum + part.byteLength, 0);
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

  test('refuses a split-track stream whose audio rendition is not readable, and says why', async () => {
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
    // This fixture's segments are not a transport stream at all, which is what a
    // server serving the wrong bytes looks like. MPEG-TS renditions that ARE readable
    // are joined — see the case below.
    expect(failed?.error?.code).toBe('stream-ts-not-a-stream');
    // A silent video is never saved, and the reason is carried on the job so the
    // popup can show it.
    expect(failed?.error?.messageKey).toBe('error.download.stream.tracks');
    const after = await extension.worker.evaluate(() =>
      chrome.downloads.search({}).then((found) => found.length),
    );
    expect(after).toBe(before);
    await popup.close();
  });

  test('joins a split-track stream into one file, byte for byte', async () => {
    // The packaging that used to be refused: h264 in one rendition, aac in another,
    // both fragmented MP4. The extension must fetch both and mux them.
    const popup = await extension.page('popup.html');
    const items = await sendMessage<readonly MediaItem[]>(popup, {
      type: 'detection/run',
      payload: {
        pageUrl: `${site.origin}/with-media.html`,
        domSignals: [
          {
            role: 'video',
            tagName: 'VIDEO',
            src: `${site.origin}/media/split/master.m3u8`,
            width: 160,
            height: 120,
          },
        ],
        observedUrls: [],
      },
    });
    const stream = items.find((item) => item.url.endsWith('split/master.m3u8'));
    expect(stream).toBeDefined();

    await sendMessage(popup, {
      type: 'download/enqueue',
      payload: { itemIds: [stream?.id ?? ''] },
    });

    const downloads = await until(
      'the joined stream to be saved',
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
        found.some(
          (item) =>
            item.state === 'complete' &&
            item.url.startsWith('blob:') &&
            item.bytes === expectedMuxedBytes(),
        ),
      60_000,
    );

    const completed = downloads.find(
      (item) => item.state === 'complete' && item.bytes === expectedMuxedBytes(),
    );
    // The browser saved exactly the bytes the muxer produces from these fixtures,
    // computed here independently of the extension.
    expect(completed?.bytes).toBe(expectedMuxedBytes());

    const queue = await sendMessage<readonly DownloadTask[]>(popup, { type: 'download/query' });
    const task = queue.find((entry) => entry.item.url.endsWith('split/master.m3u8'));
    expect(task?.state).toBe('completed');
    // A joined stream is an MP4, whatever the playlist was called.
    expect(task?.filename.endsWith('.mp4')).toBe(true);
    await popup.close();
  });

  test('joins split-track MPEG-TS renditions by demultiplexing them', async () => {
    // The case 1.3.0 refused outright: real h264 in one transport-stream rendition,
    // real aac in another. Joining these means taking both apart and re-packaging
    // them, so the assertion is the bytes the shipped code produces, computed here
    // independently, and the container it chose.
    const popup = await extension.page('popup.html');
    const items = await sendMessage<readonly MediaItem[]>(popup, {
      type: 'detection/run',
      payload: {
        pageUrl: `${site.origin}/with-media.html`,
        domSignals: [
          {
            role: 'video',
            tagName: 'VIDEO',
            src: `${site.origin}/media/split-ts/master.m3u8`,
            width: 160,
            height: 120,
          },
        ],
        observedUrls: [],
      },
    });
    const stream = items.find((item) => item.url.endsWith('split-ts/master.m3u8'));
    expect(stream).toBeDefined();

    await sendMessage(popup, {
      type: 'download/enqueue',
      payload: { itemIds: [stream?.id ?? ''] },
    });

    const expected = expectedRemuxedBytes();
    const downloads = await until(
      'the remuxed transport streams to be saved',
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
        found.some(
          (item) =>
            item.state === 'complete' && item.url.startsWith('blob:') && item.bytes === expected,
        ),
      60_000,
    );

    expect(
      downloads.some(
        (item) =>
          item.state === 'complete' && item.url.startsWith('blob:') && item.bytes === expected,
      ),
    ).toBe(true);

    const queue = await sendMessage<readonly DownloadTask[]>(popup, { type: 'download/query' });
    const task = queue.find((entry) => entry.item.url.endsWith('split-ts/master.m3u8'));
    expect(task?.state).toBe('completed');
    // Two transport streams in, one MP4 out.
    expect(task?.filename.endsWith('.mp4')).toBe(true);
    await popup.close();
  });

  test('the segment count the assembly reported matches the fixture', async () => {
    // Cheap consistency check on the fixture itself, so a mis-sized fixture cannot
    // make the assertion above pass for the wrong reason.
    expect(HLS_TOTAL_BYTES / HLS_SEGMENT_COUNT).toBe(4096);
  });
});

test.describe('AetherDL lets the user choose a stream quality in Chromium (§10.6)', () => {
  test.describe.configure({ mode: 'serial' });

  let extension: LoadedExtension;
  let site: FixtureSite;
  let stagedDir: string;

  function stageWithLoopbackAccess(): string {
    const dir = mkdtempSync(join(tmpdir(), 'aetherdl-quality-e2e-'));
    cpSync(distDir('chrome'), dir, { recursive: true });
    const manifestPath = join(dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
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

  /** Detect the ladder playlist and return its item id. */
  async function detectLadder(
    popup: Awaited<ReturnType<LoadedExtension['page']>>,
  ): Promise<string> {
    const items = await sendMessage<readonly MediaItem[]>(popup, {
      type: 'detection/run',
      payload: {
        pageUrl: `${site.origin}/with-media.html`,
        domSignals: [
          {
            role: 'video',
            tagName: 'VIDEO',
            src: `${site.origin}/media/hls/ladder.m3u8`,
            width: 1920,
            height: 1080,
          },
        ],
        observedUrls: [],
      },
    });
    const stream = items.find((item) => item.url.endsWith('ladder.m3u8'));
    expect(stream).toBeDefined();
    return stream?.id ?? '';
  }

  const savedUrls = new Set<string>();

  /**
   * The bytes of the download that appeared since the last check.
   *
   * Identified by its blob URL rather than by position: `chrome.downloads.search`
   * makes no promise about order, and reading "the last one" made a stale result look
   * like a fresh one — which is exactly the failure this assertion exists to catch.
   */
  async function bytesOfNewSave(): Promise<number> {
    const isNew = (item: NativeDownload): boolean =>
      item.state === 'complete' && item.url.startsWith('blob:') && !savedUrls.has(item.url);
    const downloads = await until(
      'a saved stream',
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
      (found: readonly NativeDownload[]) => found.some(isNew),
      60_000,
    );
    const fresh = downloads.find(isNew);
    if (fresh !== undefined) {
      savedUrls.add(fresh.url);
    }
    return fresh?.bytes ?? -1;
  }

  test('lists the ladder over the real message bus, marking what it would take', async () => {
    const popup = await extension.page('popup.html');

    const renditions = await sendMessage<readonly StreamRenditionSnapshot[]>(popup, {
      type: 'stream/qualities',
      payload: { manifestUrl: `${site.origin}/media/hls/ladder.m3u8` },
    });

    expect(renditions.map((rendition) => rendition.height)).toEqual(
      HLS_LADDER.map((rung) => rung.height),
    );
    // The default preference is `highest`, so the tallest rung is the one marked.
    expect(renditions.filter((rendition) => rendition.isPreferred).map((r) => r.height)).toEqual([
      1080,
    ]);
    await popup.close();
  });

  test('downloads the rendition the user pinned, not the biggest one', async () => {
    const popup = await extension.page('popup.html');
    const itemId = await detectLadder(popup);

    await sendMessage(popup, {
      type: 'download/enqueue',
      payload: { itemIds: [itemId], renditionId: `${site.origin}/media/hls/q-360.m3u8` },
    });

    // The saved size is the proof: each rung serves a different segment size, so this
    // cannot pass by accident (§16.3).
    expect(await bytesOfNewSave()).toBe(ladderTotalBytes(360));
    await popup.close();
  });

  test('honours the saved quality preference when nothing is pinned', async () => {
    const popup = await extension.page('popup.html');
    await sendMessage(popup, { type: 'settings/update', payload: { streamQuality: '720' } });
    const itemId = await detectLadder(popup);

    await sendMessage(popup, { type: 'download/enqueue', payload: { itemIds: [itemId] } });

    // 720 is the tallest rung at or below the cap; 1080 exists and is NOT taken.
    expect(await bytesOfNewSave()).toBe(ladderTotalBytes(720));

    // Restore the default so a later run of this file starts where it started.
    await sendMessage(popup, { type: 'settings/update', payload: { streamQuality: 'highest' } });
    await popup.close();
  });
});
