// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserFrom } from '@platform/browser/factory';
import { createMessageBus } from '@platform/messaging/service';
import type { MessageBus } from '@platform/messaging';
import { DEFAULT_SETTINGS } from '@core/settings';
import { SETTINGS_CHANGED_CHANNEL } from '@shared/constants';
import type { HistoryRecord, Settings } from '@shared/types';
import { createSettingsRuntimeClient } from '@runtime/settings/client';
import { createFakeWebExt, type FakeWebExt } from '../../platform/_fake-webext';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Harness {
  readonly fake: FakeWebExt;
  readonly client: ReturnType<typeof createSettingsRuntimeClient>;
  readonly background: MessageBus;
  readonly requests: { type: string; payload: unknown }[];
}

function setup(firefox = false): Harness {
  const fake = createFakeWebExt(firefox ? { firefox: true } : {});
  const client = createSettingsRuntimeClient(
    createBrowserFrom(fake.api, firefox ? 'firefox' : 'chrome'),
  );
  const background = createMessageBus(fake.api);
  const requests: { type: string; payload: unknown }[] = [];

  const record =
    <T>(type: string, response: T) =>
    (payload: unknown): T => {
      requests.push({ type, payload });
      return response;
    };

  background.on('settings/get', record('settings/get', DEFAULT_SETTINGS));
  background.on('settings/update', record('settings/update', DEFAULT_SETTINGS));
  background.on('settings/reset', record('settings/reset', DEFAULT_SETTINGS));
  background.on('history/query', record<readonly HistoryRecord[]>('history/query', []));
  background.on('history/delete', record('history/delete', undefined));
  background.on('history/clear', record('history/clear', undefined));
  background.on('history/export', record('history/export', '{"version":1,"records":[]}\n'));

  return { fake, client, background, requests };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runtime/settings client adapter', () => {
  it('maps every settings and history intent onto its approved message', async () => {
    const { client, requests } = setup();

    await client.getSettings();
    await client.updateSettings({ theme: 'dark' });
    await client.resetSettings();
    await client.queryHistory();
    await client.deleteHistory('a');
    await client.clearHistory();

    expect(requests).toEqual([
      { type: 'settings/get', payload: undefined },
      { type: 'settings/update', payload: { theme: 'dark' } },
      { type: 'settings/reset', payload: undefined },
      { type: 'history/query', payload: undefined },
      { type: 'history/delete', payload: { id: 'a' } },
      { type: 'history/clear', payload: undefined },
    ]);
  });

  it('propagates a rejected settings change to the caller', async () => {
    const fake = createFakeWebExt();
    const client = createSettingsRuntimeClient(createBrowserFrom(fake.api, 'chrome'));
    createMessageBus(fake.api).on('settings/update', () => {
      throw new Error('invalid');
    });

    await expect(client.updateSettings({ maxRetries: 99 })).rejects.toMatchObject({
      category: 'internal',
    });
  });

  it('checks, requests and revokes an optional permission by its Chromium name', async () => {
    const { fake, client } = setup();
    const request = vi.spyOn(fake.api.permissions, 'request');

    expect(await client.hasPermission('contextMenus')).toBe(false);
    expect(await client.requestPermission('contextMenus')).toBe(true);
    expect(request).toHaveBeenCalledWith({ permissions: ['contextMenus'] });
    expect(await client.hasPermission('contextMenus')).toBe(true);

    expect(await client.removePermission('contextMenus')).toBe(true);
    expect(await client.hasPermission('contextMenus')).toBe(false);
  });

  it('uses the Firefox menus permission name on Firefox', async () => {
    const { fake, client } = setup(true);
    const request = vi.spyOn(fake.api.permissions, 'request');
    await client.requestPermission('contextMenus');
    expect(request).toHaveBeenCalledWith({ permissions: ['menus'] });
  });

  it('uses the same name for notifications on both targets', async () => {
    for (const firefox of [false, true]) {
      const { fake, client } = setup(firefox);
      const request = vi.spyOn(fake.api.permissions, 'request');
      await client.requestPermission('notifications');
      expect(request).toHaveBeenCalledWith({ permissions: ['notifications'] });
    }
  });

  it('reads the extension version for the About section', () => {
    const { client } = setup();
    expect(client.getVersion()).toBe('0.1.0');
  });

  it('saves the export locally through a transient object URL', async () => {
    const { client } = setup();
    const created: string[] = [];
    const revoked: string[] = [];
    const clicks: string[] = [];
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (): string => {
        created.push('blob:local');
        return 'blob:local';
      },
      revokeObjectURL: (url: string): void => {
        revoked.push(url);
      },
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(this.download);
    });

    await client.exportHistory('aetherdl-history.json');
    await flush();

    expect(created).toEqual(['blob:local']);
    expect(clicks).toEqual(['aetherdl-history.json']);
    // The URL is released immediately; nothing is uploaded anywhere (§12.7, §14.3).
    expect(revoked).toEqual(['blob:local']);
    expect(document.querySelector('a[download]')).toBeNull();
    click.mockRestore();
    vi.unstubAllGlobals();
  });

  it('delivers settings broadcasts and ignores malformed ones', async () => {
    const { fake, client } = setup();
    const seen: Settings[] = [];
    const unsubscribe = client.onSettingsChanged((settings) => seen.push(settings));
    const publisher = createMessageBus(fake.api);

    await publisher.broadcast(SETTINGS_CHANGED_CHANNEL, DEFAULT_SETTINGS);
    await publisher.broadcast(SETTINGS_CHANGED_CHANNEL, { nonsense: true });
    await publisher.broadcast(SETTINGS_CHANGED_CHANNEL, null);
    await flush();

    expect(seen).toEqual([DEFAULT_SETTINGS]);

    unsubscribe();
    await publisher.broadcast(SETTINGS_CHANGED_CHANNEL, DEFAULT_SETTINGS);
    await flush();
    expect(seen).toHaveLength(1);
  });
});

describe('runtime/settings client — site access (§4.15)', () => {
  it('reports the origins the browser says are granted, in a stable order', async () => {
    const { fake, client } = setup();
    fake.grantedOrigins.add('https://media.example/*');
    fake.grantedOrigins.add('https://cdn.test/*');

    expect(await client.listSiteAccess()).toEqual([
      'https://cdn.test/*',
      'https://media.example/*',
    ]);
  });

  it('reports nothing when nothing is granted', async () => {
    const { client } = setup();

    expect(await client.listSiteAccess()).toEqual([]);
  });

  it('withdraws exactly the origin it was given', async () => {
    const { fake, client } = setup();
    fake.grantedOrigins.add('https://cdn.test/*');
    fake.grantedOrigins.add('https://media.example/*');

    expect(await client.revokeSiteAccess('https://cdn.test/*')).toBe(true);
    expect([...fake.grantedOrigins]).toEqual(['https://media.example/*']);
  });
});
