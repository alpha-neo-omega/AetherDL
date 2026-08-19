import { describe, expect, it } from 'vitest';
import { detectCapabilities, isSupported } from '@platform/browser/capabilities';
import { createFakeWebExt } from './_fake-webext';

describe('platform/browser capabilities', () => {
  it('detects Firefox capabilities including session storage and browserInfo', () => {
    const caps = detectCapabilities(
      createFakeWebExt({ firefox: true, withSession: true }).api,
      'firefox',
    );
    expect(caps.promises).toBe(true);
    expect(caps.sessionStorage).toBe(true);
    expect(caps.syncStorage).toBe(true);
    expect(caps.downloads).toBe(true);
    expect(caps.permissions).toBe(true);
    expect(caps.browserInfo).toBe(true);
    expect(caps.contextMenus).toBe(false);
    expect(isSupported(caps, 'promises')).toBe(true);
  });

  it('detects reduced Chromium capabilities when session storage is absent', () => {
    const caps = detectCapabilities(createFakeWebExt().api, 'chrome');
    expect(caps.sessionStorage).toBe(false);
    expect(caps.browserInfo).toBe(false);
    expect(isSupported(caps, 'sessionStorage')).toBe(false);
  });

  it('maps context-menu capability per target: Firefox reads `menus` (§7.4)', () => {
    const withMenus = detectCapabilities(
      createFakeWebExt({ firefox: true, menus: true }).api,
      'firefox',
    );
    expect(withMenus.contextMenus).toBe(true);

    // Firefox must NOT read `contextMenus`; only `menus` counts.
    const wrongApi = detectCapabilities(
      createFakeWebExt({ firefox: true, contextMenus: true }).api,
      'firefox',
    );
    expect(wrongApi.contextMenus).toBe(false);
  });

  it('maps context-menu capability per target: Chromium reads `contextMenus` (§7.4)', () => {
    const withContextMenus = detectCapabilities(
      createFakeWebExt({ contextMenus: true }).api,
      'chrome',
    );
    expect(withContextMenus.contextMenus).toBe(true);

    // Chromium must NOT read `menus`; only `contextMenus` counts.
    const wrongApi = detectCapabilities(createFakeWebExt({ menus: true }).api, 'chrome');
    expect(wrongApi.contextMenus).toBe(false);
  });

  it('detects notifications and commands when present', () => {
    const caps = detectCapabilities(
      createFakeWebExt({ notifications: true, commands: true }).api,
      'chrome',
    );
    expect(caps.notifications).toBe(true);
    expect(caps.commands).toBe(true);
  });
});
