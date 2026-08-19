// @vitest-environment jsdom
/**
 * Integration: the React popup over the real background runtimes — detection
 * results reach the surface, a click travels the approved `download/*` contract to
 * the Download Manager, and the runtime's pushed events drive the UI back
 * (PROJECT_BIBLE.md §8.5, §8.6, §11.1). Nothing between the popup and the browser
 * is mocked except the WebExtension namespace itself.
 */
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { createBrowserFrom } from '@platform/browser/factory';
import { createMessageBus } from '@platform/messaging/service';
import { PopupApp } from '@ui/popup';
import type { MediaPreferences } from '@ui/design-system';
import {
  createBackgroundDownloadRuntime,
  createDetectionItemResolver,
} from '@runtime/background/downloads';
import { createBackgroundRuntime } from '@runtime/background/runtime';
import { createPopupRuntimeClient } from '@runtime/popup/client';
import { createMemoryObjectStore } from '../unit/core/storage/_fixtures';
import { createFakeWebExt } from '../unit/platform/_fake-webext';
import { createFakeEngine, mediaItem, report } from '../unit/runtime/_fixtures';
import {
  click,
  flush,
  render,
  requireByName,
  requireByNamePrefix,
  texts,
} from '../unit/ui/_render';

const TAB = 11;
const NO_MEDIA_QUERIES: MediaPreferences = {
  matches: () => false,
  subscribe: () => () => undefined,
};

/** Run background/browser work inside `act` so React sees the resulting updates. */
async function run(work: () => Promise<unknown>): Promise<void> {
  await act(async () => {
    await work();
  });
}

function boot() {
  const fake = createFakeWebExt();
  fake.grantedPermissions.add('downloads');
  fake.setTabs([{ id: TAB, active: true, url: 'https://example.com/watch', windowId: 1 }]);
  const browser = createBrowserFrom(fake.api, 'chrome');

  const engine = createFakeEngine();
  const detection = createBackgroundRuntime({ browser, engine: engine.manager, clock: () => 0 });
  detection.start();

  let counter = 0;
  const downloads = createBackgroundDownloadRuntime({
    browser,
    resolver: createDetectionItemResolver(detection.state),
    store: createMemoryObjectStore(),
    clock: () => 1000,
    random: () => 0,
    generateId: () => {
      counter += 1;
      return `job-${counter}`;
    },
  });
  downloads.start();

  const content = createMessageBus(fake.api);
  const client = createPopupRuntimeClient(browser);
  return { fake, engine, detection, downloads, content, client };
}

function openPopup(client: ReturnType<typeof createPopupRuntimeClient>) {
  return render(<PopupApp client={client} media={NO_MEDIA_QUERIES} locale="en-US" />);
}

async function nativeState(
  fake: ReturnType<typeof createFakeWebExt>,
  id: number,
  state: string,
  bytes?: { received: number; total: number },
): Promise<void> {
  await run(async () => {
    fake.downloadItems.set(id, {
      id,
      state,
      bytesReceived: bytes?.received ?? 0,
      totalBytes: bytes?.total ?? 100,
      filename: 'download',
    });
    fake.onDownloadChanged.trigger({ id, state: { current: state } });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('popup over the background runtime', () => {
  it('shows the media the detection engine found for the active tab', async () => {
    const { engine, content, client } = boot();
    engine.setItems([
      mediaItem({ id: 'clip', title: 'Holiday Clip', url: 'https://example.com/clip.mp4' }),
    ]);
    await run(() => content.send('detection/run', report()));

    const view = openPopup(client);
    await flush();

    expect(texts(view.container, '.adl-card__title')).toEqual(['Holiday Clip']);
    expect(view.container.querySelector('.adl-toolbar__count')?.textContent).toBe('1 item');
    view.unmount();
  });

  it('starts a real download from a click and reflects progress and completion', async () => {
    const { fake, engine, content, client, downloads } = boot();
    engine.setItems([
      mediaItem({ id: 'clip', title: 'Holiday Clip', url: 'https://example.com/clip.mp4' }),
    ]);
    await run(() => content.send('detection/run', report()));

    const view = openPopup(client);
    await flush();

    await run(async () => {
      click(requireByNamePrefix(view.container, 'Download: Holiday Clip'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();

    // The browser really was asked to download, through the Download Manager.
    expect(fake.downloadItems.size).toBe(1);
    expect(downloads.snapshot().stats.active).toBe(1);
    expect(view.container.querySelector('.adl-card__status')?.textContent).toContain('Downloading');

    await nativeState(fake, 1, 'in_progress', { received: 60, total: 120 });
    await flush();
    expect(
      view.container.querySelector('.adl-card [role="progressbar"]')?.getAttribute('aria-valuenow'),
    ).toBe('50');

    await nativeState(fake, 1, 'complete', { received: 120, total: 120 });
    await flush();
    expect(view.container.querySelector('.adl-card__status')?.textContent).toContain('Completed');
    expect(view.container.querySelector('.adl-queue__summary')?.textContent).toBe(
      '0 active · 0 queued',
    );
    view.unmount();
  });

  it('cancels a running download from the queue panel', async () => {
    const { fake, engine, content, client } = boot();
    engine.setItems([mediaItem({ id: 'clip', url: 'https://example.com/clip.mp4' })]);
    await run(() => content.send('detection/run', report()));

    const view = openPopup(client);
    await flush();
    await run(async () => {
      click(requireByNamePrefix(view.container, 'Download:'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();

    click(requireByName(view.container, 'Show queue'));
    await run(async () => {
      click(requireByNamePrefix(view.container, 'Cancel:'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();

    expect(fake.downloadItems.get(1)?.state).toBe('interrupted');
    expect(view.container.querySelector('.adl-card__status')?.textContent).toContain('Cancelled');
    view.unmount();
  });

  it('refuses protected media end to end: no browser download, clear refusal in the UI', async () => {
    const { fake, engine, content, client, downloads } = boot();
    engine.setItems([
      mediaItem({
        id: 'drm',
        title: 'Protected Stream',
        url: 'https://example.com/stream.m3u8',
        status: 'unsupported',
        unsupportedReason: 'Protected content',
      }),
    ]);
    await run(() => content.send('detection/run', report()));

    const view = openPopup(client);
    await flush();

    const download = requireByNamePrefix(
      view.container,
      'Download: Protected Stream',
    ) as HTMLButtonElement;
    expect(download.disabled).toBe(true);
    expect(view.container.querySelector('.adl-card__badge')?.textContent).toContain('Unsupported');

    await run(async () => {
      click(download);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fake.downloadItems.size).toBe(0);
    expect(downloads.snapshot().stats.total).toBe(0);
    view.unmount();
  });

  it('asks the background to observe the page when it opens, and shows what comes back', async () => {
    const { fake, engine, content, client } = boot();
    engine.setItems([mediaItem({ id: 'clip', title: 'Holiday Clip' })]);

    const view = openPopup(client);
    await flush();

    // Opening the popup is the user gesture that permits observation (§13.7); the
    // background injects the content script into the active tab (§8.10).
    expect(fake.scripting.executed).toEqual([{ target: { tabId: TAB }, files: ['content.js'] }]);
    expect(texts(view.container, '.adl-card__title')).toEqual([]);

    // The injected observer reports what it sees; the popup follows the stream.
    await run(() => content.send('detection/run', report()));
    await flush();

    expect(texts(view.container, '.adl-card__title')).toEqual(['Holiday Clip']);
    view.unmount();
  });

  it('updates live when the background announces newly detected media', async () => {
    const { engine, content, client } = boot();
    const view = openPopup(client);
    await flush();
    expect(view.container.querySelector('.adl-status--empty')).not.toBeNull();

    engine.setItems([mediaItem({ id: 'late', title: 'Appeared Later' })]);
    await run(() => content.send('detection/run', report()));
    await flush();

    expect(texts(view.container, '.adl-card__title')).toEqual(['Appeared Later']);
    view.unmount();
  });

  it('reports a background permission refusal to the user', async () => {
    const { fake, engine, content, client } = boot();
    engine.setItems([mediaItem({ id: 'clip', url: 'https://example.com/clip.mp4' })]);
    await run(() => content.send('detection/run', report()));

    const view = openPopup(client);
    await flush();

    fake.grantedPermissions.delete('downloads');
    await run(async () => {
      click(requireByNamePrefix(view.container, 'Download:'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();

    expect(fake.downloadItems.size).toBe(0);
    expect(view.container.querySelector('.adl-notice')?.textContent).toContain(
      'downloads permission',
    );
    view.unmount();
  });

  it('is stateless across opens: a reopened popup reads the live queue back', async () => {
    const { fake, engine, content, client } = boot();
    engine.setItems([
      mediaItem({ id: 'clip', title: 'Clip', url: 'https://example.com/clip.mp4' }),
    ]);
    await run(() => content.send('detection/run', report()));

    const first = openPopup(client);
    await flush();
    await run(async () => {
      click(requireByNamePrefix(first.container, 'Download: Clip'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();
    await nativeState(fake, 1, 'complete', { received: 100, total: 100 });
    await flush();
    // Popup closed — the background keeps owning the queue (§8.7, §8.11).
    first.unmount();

    const second = openPopup(client);
    await flush();

    expect(second.container.querySelector('.adl-card__status')?.textContent).toContain('Completed');
    click(requireByName(second.container, 'Show queue'));
    expect(texts(second.container, '.adl-queue__item-state')).toEqual(['Completed']);
    second.unmount();
  });
});
