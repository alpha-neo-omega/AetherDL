// @vitest-environment jsdom
/**
 * Integration: the settings page over the real background settings runtime and core
 * services — a change travels the ratified `settings/*` contract, is validated and
 * persisted, and is announced to every open surface; history is recorded, browsed
 * and erased locally (PROJECT_BIBLE.md §4.9, §4.11, §8.5, §14).
 */
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserFrom } from '@platform/browser/factory';
import { DEFAULT_SETTINGS } from '@core/settings';
import { createSettingsService } from '@core/settings/settings';
import { createHistoryService } from '@core/history/history';
import { createHistoryRepository } from '@core/storage/history-repository';
import { createSettingsRepository } from '@core/storage/settings-repository';
import type { HistoryRecord, Settings } from '@shared/types';
import type { MediaPreferences } from '@ui/design-system';
import { SettingsApp } from '@ui/settings';
import { PopupApp } from '@ui/popup';
import { createBackgroundSettingsRuntime } from '@runtime/background/settings';
import { createSettingsRuntimeClient } from '@runtime/settings/client';
import { createPopupRuntimeClient } from '@runtime/popup/client';
import { createMemoryObjectStore } from '../unit/core/storage/_fixtures';
import { createFakeWebExt } from '../unit/platform/_fake-webext';
import {
  click,
  flush,
  render,
  requireByName,
  selectOption,
  texts,
  type Rendered,
} from '../unit/ui/_render';

const NOW = 1_700_000_000_000;
const NO_MEDIA_QUERIES: MediaPreferences = {
  matches: () => false,
  subscribe: () => () => undefined,
};

function historyRecord(props: Partial<HistoryRecord> & { readonly id: string }): HistoryRecord {
  return {
    title: `Title ${props.id}`,
    kind: 'video',
    originHost: 'example.com',
    timestamp: NOW,
    outcome: 'completed',
    filename: `${props.id}.mp4`,
    ...props,
  };
}

function boot() {
  const fake = createFakeWebExt();
  const browser = createBrowserFrom(fake.api, 'chrome');
  const store = createMemoryObjectStore();
  const settings = createSettingsService({
    repository: createSettingsRepository(browser.storage.local),
  });
  const history = createHistoryService({
    repository: createHistoryRepository({ store }),
    settings,
    clock: () => NOW,
    sessionStartedAt: NOW,
  });
  const runtime = createBackgroundSettingsRuntime({ browser, settings, history });
  runtime.start();
  return {
    fake,
    browser,
    store,
    settings,
    history,
    runtime,
    client: createSettingsRuntimeClient(browser),
  };
}

function openSettings(client: ReturnType<typeof createSettingsRuntimeClient>): Rendered {
  return render(<SettingsApp client={client} media={NO_MEDIA_QUERIES} locale="en-US" />);
}

function byId(container: HTMLElement, id: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>('[id]')].find((node) => node.id === id);
}

function field(view: Rendered, label: string): HTMLElement {
  const labelEl = [...view.container.querySelectorAll('label')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (labelEl === undefined) {
    throw new Error(`No field labelled "${label}"`);
  }
  const control = byId(view.container, labelEl.htmlFor);
  if (control === undefined) {
    throw new Error(`Label "${label}" points at no control`);
  }
  return control;
}

describe('settings page over the background runtime', () => {
  it('persists a change to local storage through the approved contract', async () => {
    const { fake, settings, client } = boot();
    const view = openSettings(client);
    await flush();

    selectOption(field(view, 'Theme') as HTMLSelectElement, 'dark');
    await flush();

    expect((await settings.get()).theme).toBe('dark');
    const stored = fake.local.data.get('aetherdl.settings') as Settings;
    expect(stored.theme).toBe('dark');
    view.unmount();
  });

  it('refuses an invalid value, writes nothing and says so', async () => {
    const { fake, client } = boot();
    const view = openSettings(client);
    await flush();

    const { type } = await import('../unit/ui/_render');
    type(field(view, 'Maximum retries') as HTMLInputElement, '42');
    await flush();

    expect(view.container.querySelector('.adl-notice')?.textContent).toContain(
      'That value is not allowed',
    );
    expect(fake.local.data.get('aetherdl.settings')).toBeUndefined();
    view.unmount();
  });

  it('restores every default from the reset control', async () => {
    const { settings, client } = boot();
    await settings.update({ theme: 'dark', keepHistory: false });
    const view = openSettings(client);
    await flush();

    click(
      requireByName(view.container, 'Reset all settings — Restores every setting to its default.'),
    );
    await flush();

    expect(await settings.get()).toEqual(DEFAULT_SETTINGS);
    view.unmount();
  });

  it('announces an applied change to an open popup', async () => {
    const { browser, client, fake } = boot();
    fake.setTabs([{ id: 3, active: true, windowId: 1 }]);
    const popupClient = createPopupRuntimeClient(browser);
    // The popup needs the download/detection handlers to load; it still applies the
    // Appearance settings the background announces (§4.9 applied live).
    const popup = render(<PopupApp client={popupClient} media={NO_MEDIA_QUERIES} />);
    await flush();

    const settingsView = openSettings(client);
    await flush();
    selectOption(field(settingsView, 'Theme') as HTMLSelectElement, 'dark');
    await flush();

    expect(document.documentElement.dataset['theme']).toBe('dark');
    settingsView.unmount();
    popup.unmount();
  });

  it('browses, deletes and erases local history', async () => {
    const { history, store, client } = boot();
    await history.record(historyRecord({ id: 'a', title: 'Clip A', timestamp: NOW - 1000 }));
    await history.record(historyRecord({ id: 'b', title: 'Clip B' }));

    const view = openSettings(client);
    await flush();
    expect(texts(view.container, '.adl-history__item-title')).toEqual(['Clip B', 'Clip A']);

    click(requireByName(view.container, 'Delete: Clip A'));
    await flush();
    expect(texts(view.container, '.adl-history__item-title')).toEqual(['Clip B']);
    expect(store.records.size).toBe(1);

    click(requireByName(view.container, 'Clear history — Erases every record from this device.'));
    await flush();
    expect(store.records.size).toBe(0);
    expect(await history.list()).toEqual([]);
    view.unmount();
  });

  it('stops recording history the moment the user turns it off', async () => {
    const { history, store, client } = boot();
    const view = openSettings(client);
    await flush();

    click(field(view, 'Keep history'));
    await flush();

    await history.record(historyRecord({ id: 'a' }));
    expect(store.records.size).toBe(0);
    view.unmount();
  });

  it('exports history to a local file, with nothing leaving the device', async () => {
    const { history, client } = boot();
    await history.record(historyRecord({ id: 'a', title: 'Clip A' }));

    const blobs: string[] = [];
    const revoked: string[] = [];
    const downloads: string[] = [];
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (blob: Blob): string => {
        blobs.push(blob.type);
        return 'blob:local';
      },
      revokeObjectURL: (url: string): void => {
        revoked.push(url);
      },
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(`${this.download}|${this.href}`);
    });

    await client.exportHistory('aetherdl-history.json');

    expect(blobs).toEqual(['application/json']);
    expect(downloads[0]).toContain('aetherdl-history.json');
    expect(revoked).toEqual(['blob:local']);
    click.mockRestore();
    vi.unstubAllGlobals();
  });

  it('requests an optional permission only from the user gesture, and revokes it', async () => {
    const { fake, client } = boot();
    const view = openSettings(client);
    await flush();
    expect(fake.grantedPermissions.has('notifications')).toBe(false);

    click(requireByName(view.container, 'Grant: Notifications'));
    await flush();
    expect(fake.grantedPermissions.has('notifications')).toBe(true);

    click(requireByName(view.container, 'Revoke: Notifications'));
    await flush();
    expect(fake.grantedPermissions.has('notifications')).toBe(false);
    view.unmount();
  });

  it('survives a background that is not answering', async () => {
    const fake = createFakeWebExt();
    const client = createSettingsRuntimeClient(createBrowserFrom(fake.api, 'chrome'));
    const view = render(<SettingsApp client={client} media={NO_MEDIA_QUERIES} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(view.container.querySelector('.adl-status--error')?.textContent).toContain(
      'AetherDL is not responding',
    );
    view.unmount();
  });
});
