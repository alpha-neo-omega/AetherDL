// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DETECTION_FINISHED_CHANNEL, DOWNLOAD_EVENT_CHANNEL } from '@shared/constants';
import { createBrowserFrom } from '@platform/browser/factory';
import { createMessageBus } from '@platform/messaging/service';
import type { MessageBus } from '@platform/messaging';
import type { DownloadEventBroadcast, DownloadTask, MediaItem } from '@shared/types';
import { createPopupRuntimeClient } from '@runtime/popup/client';
import { createFakeWebExt, type FakeWebExt } from '../../platform/_fake-webext';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Harness {
  readonly fake: FakeWebExt;
  readonly client: ReturnType<typeof createPopupRuntimeClient>;
  /** Stands in for the background: records requests and answers them. */
  readonly background: MessageBus;
  readonly requests: { type: string; payload: unknown }[];
}

function setup(): Harness {
  const fake = createFakeWebExt();
  fake.setTabs([{ id: 5, active: true, url: 'https://example.com', windowId: 1 }]);
  const client = createPopupRuntimeClient(createBrowserFrom(fake.api, 'chrome'));
  const background = createMessageBus(fake.api);
  const requests: { type: string; payload: unknown }[] = [];

  const record =
    <T>(type: string, response: T) =>
    (payload: unknown): T => {
      requests.push({ type, payload });
      return response;
    };

  background.on('detection/query', record<readonly MediaItem[]>('detection/query', []));
  background.on('download/query', record<readonly DownloadTask[]>('download/query', []));
  background.on('download/enqueue', record('download/enqueue', undefined));
  background.on('download/cancel', record('download/cancel', undefined));
  background.on('download/retry', record('download/retry', undefined));
  background.on('download/pause', record('download/pause', undefined));
  background.on('download/resume', record('download/resume', undefined));
  background.on('download/remove', record('download/remove', undefined));
  background.on('download/clear', record('download/clear', undefined));

  return { fake, client, background, requests };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis.navigator, 'clipboard');
});

describe('runtime/popup client adapter', () => {
  it('reads the active tab from the platform facade', async () => {
    const { client } = setup();
    expect(await client.getActiveTabId()).toBe(5);
  });

  it('reports no active tab when the browser has none', async () => {
    const { fake, client } = setup();
    fake.setTabs([]);
    expect(await client.getActiveTabId()).toBeUndefined();
  });

  it('maps every popup intent onto its approved message', async () => {
    const { client, requests } = setup();

    await client.queryDetection(5);
    await client.queryQueue();
    await client.enqueue(['a', 'b']);
    await client.cancel('t1');
    await client.retry('t2');
    await client.pause('t3');
    await client.resume('t4');
    await client.remove('t5');
    await client.clearQueue();

    expect(requests).toEqual([
      { type: 'detection/query', payload: { tabId: 5 } },
      { type: 'download/query', payload: undefined },
      { type: 'download/enqueue', payload: { itemIds: ['a', 'b'] } },
      { type: 'download/cancel', payload: { taskId: 't1' } },
      { type: 'download/retry', payload: { taskId: 't2' } },
      { type: 'download/pause', payload: { taskId: 't3' } },
      { type: 'download/resume', payload: { taskId: 't4' } },
      { type: 'download/remove', payload: { taskId: 't5' } },
      { type: 'download/clear', payload: undefined },
    ]);
  });

  it('propagates a failing background handler instead of hiding it', async () => {
    const fake = createFakeWebExt();
    const client = createPopupRuntimeClient(createBrowserFrom(fake.api, 'chrome'));
    createMessageBus(fake.api).on('download/cancel', () => {
      throw new Error('background is gone');
    });

    await expect(client.cancel('t1')).rejects.toMatchObject({ category: 'internal' });
  });

  it('propagates an unanswered request when the background is not running', async () => {
    const fake = createFakeWebExt();
    const client = createPopupRuntimeClient(createBrowserFrom(fake.api, 'chrome'));

    await expect(client.queryQueue()).rejects.toMatchObject({
      category: 'internal',
      code: 'messaging-no-response',
    });
  });

  it('delivers download broadcasts and ignores malformed ones', async () => {
    const { fake, client } = setup();
    const seen: DownloadEventBroadcast[] = [];
    const unsubscribe = client.onDownloadEvent((event) => seen.push(event));
    const publisher = createMessageBus(fake.api);

    await publisher.broadcast(DOWNLOAD_EVENT_CHANNEL, { event: 'download:queued' });
    await publisher.broadcast(DOWNLOAD_EVENT_CHANNEL, { nonsense: true });
    await publisher.broadcast(DOWNLOAD_EVENT_CHANNEL, null);
    await flush();

    expect(seen).toEqual([{ event: 'download:queued' }]);
    unsubscribe();

    await publisher.broadcast(DOWNLOAD_EVENT_CHANNEL, { event: 'download:completed' });
    await flush();
    expect(seen).toHaveLength(1);
  });

  it('delivers detection announcements and ignores malformed ones', async () => {
    const { fake, client } = setup();
    const seen: number[] = [];
    const unsubscribe = client.onDetectionFinished((tabId) => seen.push(tabId));
    const publisher = createMessageBus(fake.api);

    await publisher.broadcast(DETECTION_FINISHED_CHANNEL, { tabId: 5, itemCount: 2 });
    await publisher.broadcast(DETECTION_FINISHED_CHANNEL, { tabId: 'five' });
    await publisher.broadcast(DETECTION_FINISHED_CHANNEL, 42);
    await flush();

    expect(seen).toEqual([5]);
    unsubscribe();
  });

  it('copies a link through the clipboard when it is available', async () => {
    const { client } = setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    await client.copyLink('https://example.com/a.mp4');

    expect(writeText).toHaveBeenCalledWith('https://example.com/a.mp4');
  });

  it('reports a typed error when the clipboard is unavailable', async () => {
    const { client } = setup();
    await expect(client.copyLink('https://example.com/a.mp4')).rejects.toMatchObject({
      category: 'internal',
      code: 'popup-clipboard-unavailable',
    });
  });
});

describe('runtime/popup client — host access for stream downloads (§13.7)', () => {
  it('asks only for the origins of the manifests in the selection', async () => {
    const { fake, client } = setup();

    const granted = await client.requestStreamAccess([
      'https://cdn.test/hls/master.m3u8',
      'https://cdn.test/hls/other.m3u8',
      'https://dash.test/vod/manifest.mpd',
      // A progressive file is saved by the browser and needs nothing from us.
      'https://files.test/clip.mp4',
    ]);

    expect(granted).toBe(true);
    // One entry per ORIGIN, not per URL, and no pattern for the plain file.
    expect([...fake.grantedOrigins].sort()).toEqual(['https://cdn.test/*', 'https://dash.test/*']);
  });

  it('asks for nothing at all when no manifest is involved', async () => {
    const { fake, client } = setup();

    const granted = await client.requestStreamAccess([
      'https://files.test/clip.mp4',
      'https://files.test/song.mp3',
    ]);

    expect(granted).toBe(true);
    expect([...fake.grantedOrigins]).toEqual([]);
  });

  it('reports a decline as a decline', async () => {
    const { fake, client } = setup();
    fake.denyPermissions = true;

    expect(await client.requestStreamAccess(['https://cdn.test/hls/master.m3u8'])).toBe(false);
    expect([...fake.grantedOrigins]).toEqual([]);
  });

  it('ignores a URL it cannot parse rather than asking for a broad pattern', async () => {
    const { fake, client } = setup();

    expect(await client.requestStreamAccess(['not a url.m3u8', ''])).toBe(true);
    expect([...fake.grantedOrigins]).toEqual([]);
  });
});

describe('runtime/popup client — activeTab already covers the page’s own origin', () => {
  it('does not prompt for a stream served by the tab the popup was opened over', async () => {
    const { fake, client } = setup();
    fake.setTabs([{ id: 5, active: true, url: 'https://site.test/watch', windowId: 1 }]);
    // The popup reads the active tab at load; that is what activates activeTab.
    await client.getActiveTabId();

    const granted = await client.requestStreamAccess(['https://site.test/hls/master.m3u8']);

    expect(granted).toBe(true);
    expect([...fake.grantedOrigins]).toEqual([]);
  });

  it('still asks for a CDN origin the page merely points at', async () => {
    const { fake, client } = setup();
    fake.setTabs([{ id: 5, active: true, url: 'https://site.test/watch', windowId: 1 }]);
    await client.getActiveTabId();

    const granted = await client.requestStreamAccess([
      'https://site.test/hls/master.m3u8',
      'https://cdn.test/hls/master.m3u8',
    ]);

    expect(granted).toBe(true);
    expect([...fake.grantedOrigins]).toEqual(['https://cdn.test/*']);
  });
});
