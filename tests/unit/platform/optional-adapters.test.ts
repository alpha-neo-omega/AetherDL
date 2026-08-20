import { describe, expect, it, vi } from 'vitest';
import { createBrowserFrom } from '@platform/browser/factory';
import { createI18nService } from '@platform/browser/i18n';
import { createMenusService, resolveMenus } from '@platform/menus/service';
import { createNotificationsService } from '@platform/notifications/service';
import { createFakeWebExt } from './_fake-webext';

describe('platform/menus', () => {
  it('exists but reports itself unavailable until the namespace appears', () => {
    // The namespace appears the moment the optional permission is granted, so the
    // adapter is built wherever the permission is offerable and answers honestly in
    // the meantime. Deciding at start-up left the feature dead for the whole session
    // after a grant.
    const bare = createFakeWebExt();
    expect(resolveMenus(bare.api)).toBeUndefined();

    const adapter = createBrowserFrom(bare.api, 'chrome').menus;
    expect(adapter).toBeDefined();
    expect(adapter?.available()).toBe(false);
  });

  it('is absent entirely where the permission cannot be offered at all', () => {
    // Firefox declares no optional menus permission, so there is nothing to wait for.
    const firefox = createFakeWebExt({ firefox: true, optionalPermissions: ['notifications'] });
    expect(createBrowserFrom(firefox.api, 'firefox').menus).toBeUndefined();
  });

  it('picks up a namespace that appears after start-up', () => {
    const fake = createFakeWebExt();
    const adapter = createBrowserFrom(fake.api, 'chrome').menus;
    expect(adapter?.available()).toBe(false);

    // What granting the permission looks like from the extension's side.
    const granted = createFakeWebExt({ contextMenus: true });
    (fake.api as { contextMenus?: unknown }).contextMenus = granted.api.contextMenus;

    expect(adapter?.available()).toBe(true);
  });

  it('uses contextMenus on Chromium and menus on Firefox', () => {
    const chromium = createFakeWebExt({ contextMenus: true });
    expect(resolveMenus(chromium.api)).toBe(chromium.api.contextMenus);
    expect(createBrowserFrom(chromium.api, 'chrome').menus).toBeDefined();

    const firefox = createFakeWebExt({ firefox: true, menus: true });
    expect(resolveMenus(firefox.api)).toBe(firefox.api.menus);
    expect(createBrowserFrom(firefox.api, 'firefox').menus).toBeDefined();
  });

  it('creates and removes entries', async () => {
    const fake = createFakeWebExt({ contextMenus: true });
    const menus = createMenusService(() => resolveMenus(fake.api));

    await menus.create({ id: 'a', title: 'Download', contexts: ['video', 'link'] });
    expect(fake.menuItems.get('a')).toEqual({
      id: 'a',
      title: 'Download',
      contexts: ['video', 'link'],
    });

    await menus.remove('a');
    expect(fake.menuItems.size).toBe(0);
  });

  it('reports a create or remove that the browser refuses', async () => {
    const fake = createFakeWebExt({ contextMenus: true });
    const menus = createMenusService(() => resolveMenus(fake.api));
    fake.failMenus = true;

    await expect(menus.create({ id: 'a', title: 'x', contexts: ['link'] })).rejects.toMatchObject({
      category: 'capability',
      code: 'menus-create-failed',
    });
    await expect(menus.remove('a')).rejects.toMatchObject({ code: 'menus-remove-failed' });
  });

  it('delivers clicks by entry id and detaches the upstream listener', () => {
    const fake = createFakeWebExt({ contextMenus: true });
    const menus = createMenusService(() => resolveMenus(fake.api));
    const seen: string[] = [];

    const unsubscribe = menus.onClicked((id) => seen.push(id));
    fake.onMenuClicked.trigger({ menuItemId: 'aetherdl:download:x' });
    fake.onMenuClicked.trigger({ menuItemId: 12 });
    expect(seen).toEqual(['aetherdl:download:x', '12']);

    unsubscribe();
    fake.onMenuClicked.trigger({ menuItemId: 'ignored' });
    expect(seen).toHaveLength(2);
    expect(fake.onMenuClicked.size).toBe(0);
  });
});

describe('platform/notifications', () => {
  it('is absent until the optional permission exposes the namespace', () => {
    const bare = createFakeWebExt();
    expect(createBrowserFrom(bare.api, 'chrome').notifications).toBeUndefined();
    expect(
      createBrowserFrom(createFakeWebExt({ notifications: true }).api, 'chrome').notifications,
    ).toBeDefined();
  });

  it('shows a basic notification, with and without an icon', async () => {
    const fake = createFakeWebExt({ notifications: true });
    const notifications = createNotificationsService(fake.api.notifications!);

    await notifications.create('one', { title: 'Done', message: 'clip.mp4' });
    await notifications.create('two', { title: 'Done', message: 'x', iconUrl: 'icons/i.png' });

    expect(fake.notifications.get('one')).toEqual({
      type: 'basic',
      title: 'Done',
      message: 'clip.mp4',
    });
    expect(fake.notifications.get('two')?.iconUrl).toBe('icons/i.png');
  });

  it('reports a notification the browser refuses', async () => {
    const fake = createFakeWebExt({ notifications: true });
    const notifications = createNotificationsService(fake.api.notifications!);
    fake.failNotifications = true;

    await expect(notifications.create('one', { title: 't', message: 'm' })).rejects.toMatchObject({
      category: 'capability',
      code: 'notifications-create-failed',
    });
  });

  it('delivers clicks and detaches the upstream listener', () => {
    const fake = createFakeWebExt({ notifications: true });
    const notifications = createNotificationsService(fake.api.notifications!);
    const seen: string[] = [];

    const unsubscribe = notifications.onClicked((id) => seen.push(id));
    fake.onNotificationClicked.trigger('one');
    unsubscribe();
    fake.onNotificationClicked.trigger('two');

    expect(seen).toEqual(['one']);
    expect(fake.onNotificationClicked.size).toBe(0);
  });
});

describe('platform/browser i18n', () => {
  it('resolves a catalogue message and the UI language', () => {
    const fake = createFakeWebExt({ messages: { popup_brand: 'AetherDL' }, uiLanguage: 'en-GB' });
    const i18n = createI18nService(fake.api);
    expect(i18n.getMessage('popup_brand')).toBe('AetherDL');
    expect(i18n.getUiLanguage()).toBe('en-GB');
  });

  it('answers empty for a name the catalogue does not translate', () => {
    const i18n = createI18nService(createFakeWebExt({ messages: {} }).api);
    expect(i18n.getMessage('missing')).toBe('');
  });

  it('degrades to empty text and English where the namespace is absent', () => {
    const i18n = createI18nService(createFakeWebExt().api);
    expect(i18n.getMessage('popup_brand')).toBe('');
    expect(i18n.getUiLanguage()).toBe('en');
  });

  it('never lets a broken catalogue take a surface down', () => {
    const fake = createFakeWebExt({ messages: {} });
    fake.api.i18n = {
      getMessage: vi.fn(() => {
        throw new Error('bad name');
      }),
      getUILanguage: vi.fn(() => {
        throw new Error('unavailable');
      }),
    };
    const i18n = createI18nService(fake.api);
    expect(i18n.getMessage('anything')).toBe('');
    expect(i18n.getUiLanguage()).toBe('en');
  });

  it('falls back to English when the engine reports no UI language', () => {
    const fake = createFakeWebExt({ messages: {} });
    fake.api.i18n = { getMessage: () => '', getUILanguage: () => '' };
    expect(createI18nService(fake.api).getUiLanguage()).toBe('en');
  });

  it('is always present on the facade, so surfaces never feature-check it', () => {
    expect(createBrowserFrom(createFakeWebExt().api, 'chrome').i18n).toBeDefined();
  });
});
