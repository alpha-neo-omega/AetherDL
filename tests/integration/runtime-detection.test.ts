/**
 * Integration: content observations → typed message → background runtime → REAL
 * detection engine → runtime cache → badge, over a fake WebExtension namespace.
 * This is the composition the injected content script + background will run (§8.9,
 * §8.10). The detection engine + detectors are used exactly as implemented.
 */
import { describe, expect, it } from 'vitest';
import { createDetectionEngine } from '@core/detection/factory';
import { createBrowserFrom } from '@platform/browser/factory';
import { createMessageBus } from '@platform/messaging/service';
import { createBackgroundRuntime } from '@runtime/background/runtime';
import { scanDocument, type DocumentLike, type MediaElementLike } from '@runtime/content/scan';
import { supportedCount } from '@runtime/background/state';
import type { DetectionReport } from '@shared/types';
import { createFakeWebExt } from '../unit/platform/_fake-webext';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function docWith(elements: readonly MediaElementLike[]): DocumentLike {
  return { querySelectorAll: () => elements };
}

function buildReport(document: DocumentLike, pageUrl: string): DetectionReport {
  const { domSignals, observedUrls } = scanDocument(document);
  return { pageUrl, domSignals, observedUrls };
}

function setup() {
  const fake = createFakeWebExt();
  const browser = createBrowserFrom(fake.api, 'chrome');
  const engine = createDetectionEngine({ clock: () => 0 });
  const runtime = createBackgroundRuntime({ browser, engine, clock: () => 0 });
  runtime.start();
  const client = createMessageBus(fake.api);
  return { fake, runtime, client, dispose: () => runtime.dispose() };
}

describe('runtime detection integration', () => {
  it('detects a progressive video reported by the content script and badges it', async () => {
    const { fake, runtime, client, dispose } = setup();
    fake.setTabs([{ id: 1, active: true, url: 'https://example.com/watch', windowId: 1 }]);

    const report = buildReport(
      docWith([
        {
          tagName: 'VIDEO',
          getAttribute: () => null,
          currentSrc: 'https://cdn.example.com/movie.mp4',
        },
      ]),
      'https://example.com/watch',
    );

    const items = await client.send('detection/run', report);
    await flush();

    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(supportedCount(items)).toBeGreaterThanOrEqual(1);
    expect(runtime.state.getItems(1).length).toBe(items.length);
    expect(fake.action.badgeText.get(1)).toBe(String(supportedCount(items)));

    const queried = await client.send('detection/query', { tabId: 1 });
    expect(queried.length).toBe(items.length);
    await dispose();
  });

  it('refuses encrypted (EME/DRM) media — never surfaced as downloadable (§6)', async () => {
    const { fake, client, dispose } = setup();
    fake.setTabs([{ id: 2, active: true, url: 'https://example.com/drm', windowId: 1 }]);

    const report = buildReport(
      docWith([
        {
          tagName: 'VIDEO',
          getAttribute: () => null,
          currentSrc: 'https://cdn.example.com/protected.mp4',
          mediaKeys: {},
        },
      ]),
      'https://example.com/drm',
    );

    const items = await client.send('detection/run', report);
    await flush();
    expect(supportedCount(items)).toBe(0);
    expect(fake.action.badgeText.get(2)).toBe('');
    await dispose();
  });

  it('clears a tab’s results on navigation', async () => {
    const { fake, runtime, client, dispose } = setup();
    fake.setTabs([{ id: 3, active: true, url: 'https://example.com/a', windowId: 1 }]);
    const report = buildReport(
      docWith([
        { tagName: 'VIDEO', getAttribute: () => null, currentSrc: 'https://cdn.example.com/a.mp4' },
      ]),
      'https://example.com/a',
    );
    await client.send('detection/run', report);
    expect(runtime.state.getItems(3).length).toBeGreaterThanOrEqual(1);

    fake.onUpdated.trigger(
      3,
      { url: 'https://example.com/b' },
      { id: 3, url: 'https://example.com/b', active: true, windowId: 1 },
    );
    await flush();
    expect(runtime.state.getItems(3)).toEqual([]);
    await dispose();
  });
});
