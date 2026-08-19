import { describe, expect, it, vi } from 'vitest';
import { createBrowserFrom } from '@platform/browser/factory';
import { DEFAULT_SETTINGS } from '@core/settings';
import type { AppError } from '@shared/result';
import type { MediaItem, Settings } from '@shared/types';
import {
  createContextMenuRuntime,
  MAX_MENU_ENTRIES,
  MENU_ID_PREFIX,
} from '@runtime/background/contextmenu';
import { createFakeWebExt, type FakeWebExtOptions } from '../../platform/_fake-webext';
import { mediaItem } from '../_fixtures';

interface Options {
  readonly settings?: Partial<Settings>;
  readonly items?: readonly MediaItem[];
  readonly granted?: boolean;
  readonly fake?: FakeWebExtOptions;
}

function setup(options: Options = {}) {
  const fake = createFakeWebExt(options.fake ?? { contextMenus: true });
  const target = options.fake?.firefox === true ? 'firefox' : 'chrome';
  if (options.granted !== false) {
    fake.grantedPermissions.add(target === 'firefox' ? 'menus' : 'contextMenus');
  }
  const browser = createBrowserFrom(fake.api, target);
  const enqueued: string[][] = [];
  const errors: AppError[] = [];
  let items = options.items ?? [];
  let settings: Settings = { ...DEFAULT_SETTINGS, ...options.settings };

  const runtime = createContextMenuRuntime({
    browser,
    getSettings: () => Promise.resolve(settings),
    getActiveItems: () => items,
    enqueue: (itemIds) => {
      enqueued.push([...itemIds]);
      return Promise.resolve();
    },
    entryTitle: (item) => `Download with AetherDL: ${item.title}`,
    onError: (error) => errors.push(error),
  });
  runtime.start();

  return {
    fake,
    runtime,
    enqueued,
    errors,
    setItems: (next: readonly MediaItem[]) => {
      items = next;
    },
    setSettings: (next: Partial<Settings>) => {
      settings = { ...settings, ...next };
    },
  };
}

describe('background context menu runtime', () => {
  it('creates one entry per supported item on media and link contexts', async () => {
    const harness = setup({
      items: [mediaItem({ id: 'a', title: 'Clip A' }), mediaItem({ id: 'b', title: 'Clip B' })],
    });
    await harness.runtime.sync();

    expect([...harness.fake.menuItems.keys()]).toEqual([
      `${MENU_ID_PREFIX}a`,
      `${MENU_ID_PREFIX}b`,
    ]);
    expect(harness.fake.menuItems.get(`${MENU_ID_PREFIX}a`)).toEqual({
      id: `${MENU_ID_PREFIX}a`,
      title: 'Download with AetherDL: Clip A',
      contexts: ['video', 'audio', 'link'],
    });
  });

  it('never offers protected media', async () => {
    const harness = setup({
      items: [
        mediaItem({ id: 'ok' }),
        mediaItem({ id: 'drm', status: 'unsupported', unsupportedReason: 'Protected' }),
      ],
    });
    await harness.runtime.sync();
    expect([...harness.fake.menuItems.keys()]).toEqual([`${MENU_ID_PREFIX}ok`]);
  });

  it('bounds the number of entries', async () => {
    const many = Array.from({ length: MAX_MENU_ENTRIES + 5 }, (_, index) =>
      mediaItem({ id: `item-${index}` }),
    );
    const harness = setup({ items: many });
    await harness.runtime.sync();
    expect(harness.fake.menuItems.size).toBe(MAX_MENU_ENTRIES);
  });

  it('stays empty while the user has the feature turned off', async () => {
    const harness = setup({ settings: { contextMenu: false }, items: [mediaItem({ id: 'a' })] });
    await harness.runtime.sync();
    expect(harness.fake.menuItems.size).toBe(0);
  });

  it('stays empty while the optional permission is not granted, and never requests it', async () => {
    const harness = setup({ granted: false, items: [mediaItem({ id: 'a' })] });
    const request = vi.spyOn(harness.fake.api.permissions, 'request');

    await harness.runtime.sync();

    expect(harness.fake.menuItems.size).toBe(0);
    expect(request).not.toHaveBeenCalled();
  });

  it('does nothing at all when the browser exposes no menu namespace', async () => {
    const harness = setup({ fake: {}, items: [mediaItem({ id: 'a' })] });
    await harness.runtime.sync();
    expect(harness.fake.menuItems.size).toBe(0);
    expect(harness.errors).toEqual([]);
  });

  it('uses the Firefox menus permission on Firefox', async () => {
    const harness = setup({
      fake: { firefox: true, menus: true },
      items: [mediaItem({ id: 'a' })],
    });
    await harness.runtime.sync();
    expect(harness.fake.menuItems.size).toBe(1);
  });

  it('removes every entry when the user turns the feature off', async () => {
    const harness = setup({ items: [mediaItem({ id: 'a' })] });
    await harness.runtime.sync();
    expect(harness.fake.menuItems.size).toBe(1);

    harness.setSettings({ contextMenu: false });
    await harness.runtime.sync();
    expect(harness.fake.menuItems.size).toBe(0);
  });

  it('removes every entry when the permission is revoked', async () => {
    const harness = setup({ items: [mediaItem({ id: 'a' })] });
    await harness.runtime.sync();

    harness.fake.grantedPermissions.delete('contextMenus');
    await harness.runtime.sync();

    expect(harness.fake.menuItems.size).toBe(0);
  });

  it('reconciles rather than rebuilding when the detected media changes', async () => {
    const harness = setup({ items: [mediaItem({ id: 'a' }), mediaItem({ id: 'b' })] });
    await harness.runtime.sync();

    harness.setItems([mediaItem({ id: 'b' }), mediaItem({ id: 'c' })]);
    await harness.runtime.sync();

    expect([...harness.fake.menuItems.keys()].sort()).toEqual([
      `${MENU_ID_PREFIX}b`,
      `${MENU_ID_PREFIX}c`,
    ]);
  });

  it('is idempotent: syncing twice leaves the same entries', async () => {
    const harness = setup({ items: [mediaItem({ id: 'a' })] });
    await harness.runtime.sync();
    await harness.runtime.sync();
    expect(harness.fake.menuItems.size).toBe(1);
  });

  it('enqueues the clicked item and ignores foreign entries', async () => {
    const harness = setup({ items: [mediaItem({ id: 'a' })] });
    await harness.runtime.sync();

    harness.fake.onMenuClicked.trigger({ menuItemId: `${MENU_ID_PREFIX}a` });
    harness.fake.onMenuClicked.trigger({ menuItemId: 'some-other-extension' });
    await Promise.resolve();

    expect(harness.enqueued).toEqual([['a']]);
  });

  it('reports a failed enqueue instead of losing it', async () => {
    const fake = createFakeWebExt({ contextMenus: true });
    fake.grantedPermissions.add('contextMenus');
    const errors: AppError[] = [];
    const runtime = createContextMenuRuntime({
      browser: createBrowserFrom(fake.api, 'chrome'),
      getSettings: () => Promise.resolve(DEFAULT_SETTINGS),
      getActiveItems: () => [mediaItem({ id: 'a' })],
      enqueue: () => Promise.reject(new Error('queue is gone')),
      entryTitle: () => 'Download',
      onError: (error) => errors.push(error),
    });
    runtime.start();
    await runtime.sync();

    fake.onMenuClicked.trigger({ menuItemId: `${MENU_ID_PREFIX}a` });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors[0]).toMatchObject({ code: 'contextmenu-enqueue-failed' });
  });

  it('reports a browser refusal to create or remove an entry', async () => {
    const harness = setup({ items: [mediaItem({ id: 'a' })] });
    harness.fake.failMenus = true;
    await harness.runtime.sync();
    expect(harness.errors[0]).toMatchObject({ code: 'menus-create-failed' });

    harness.fake.failMenus = false;
    await harness.runtime.sync();
    harness.setItems([]);
    harness.fake.failMenus = true;
    await harness.runtime.sync();
    expect(harness.errors.some((error) => error.code === 'menus-remove-failed')).toBe(true);
  });

  it('reports a settings read that fails and leaves the menu empty', async () => {
    const fake = createFakeWebExt({ contextMenus: true });
    fake.grantedPermissions.add('contextMenus');
    const errors: AppError[] = [];
    const runtime = createContextMenuRuntime({
      browser: createBrowserFrom(fake.api, 'chrome'),
      getSettings: () => Promise.reject(new Error('storage down')),
      getActiveItems: () => [mediaItem({ id: 'a' })],
      enqueue: () => Promise.resolve(),
      entryTitle: () => 'Download',
      onError: (error) => errors.push(error),
    });
    runtime.start();
    await runtime.sync();

    expect(errors[0]).toMatchObject({ code: 'contextmenu-settings-failed' });
    expect(fake.menuItems.size).toBe(0);
  });

  it('reports a permission check that fails and stays silent', async () => {
    const fake = createFakeWebExt({ contextMenus: true });
    fake.api.permissions.contains = () => Promise.reject(new Error('permissions unavailable'));
    const errors: AppError[] = [];
    const runtime = createContextMenuRuntime({
      browser: createBrowserFrom(fake.api, 'chrome'),
      getSettings: () => Promise.resolve(DEFAULT_SETTINGS),
      getActiveItems: () => [mediaItem({ id: 'a' })],
      enqueue: () => Promise.resolve(),
      entryTitle: () => 'Download',
      onError: (error) => errors.push(error),
    });
    runtime.start();
    await runtime.sync();

    expect(errors[0]?.category).toBe('permission');
    expect(fake.menuItems.size).toBe(0);
  });

  it('removes its entries and stops listening on dispose', async () => {
    const harness = setup({ items: [mediaItem({ id: 'a' })] });
    await harness.runtime.sync();

    await harness.runtime.dispose();
    await harness.runtime.dispose();

    expect(harness.fake.menuItems.size).toBe(0);
    expect(harness.fake.onMenuClicked.size).toBe(0);

    // A sync after dispose must not resurrect the menu.
    await harness.runtime.sync();
    expect(harness.fake.menuItems.size).toBe(0);
  });

  it('start is idempotent and is a no-op without a menu namespace', () => {
    const harness = setup({ items: [] });
    harness.runtime.start();
    expect(harness.fake.onMenuClicked.size).toBe(1);
  });
});
