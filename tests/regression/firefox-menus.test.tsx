// @vitest-environment jsdom
/**
 * Regression (PROJECT_BIBLE.md §7.2, §7.4, §13.3): the Firefox build declared
 * `menus` in `optional_permissions`. Firefox does not accept it there — Mozilla's
 * add-on linter rejects the manifest outright — so the Settings page offered a
 * "Grant: Context menu" button that could never succeed, and the context-menu
 * preference did nothing.
 *
 * The fix declares no menus permission on Firefox at all (least privilege: nothing
 * is taken at install either) and lets each surface ask the platform what the
 * running target can actually offer. Chromium is untouched.
 */
import { describe, expect, it } from 'vitest';
import { optionalPermissionsFor } from '../../build/manifest/targets';
import { generateManifest } from '../../build/manifest/generate';
import { createBrowserFrom } from '@platform/browser/factory';
import { readManifest } from '@platform/browser/manifest';
import { DEFAULT_SETTINGS } from '@core/settings';
import { createSettingsRuntimeClient } from '@runtime/settings/client';
import { createContextMenuRuntime } from '@runtime/background/contextmenu';
import { SettingsApp } from '@ui/settings';
import type { MediaPreferences } from '@ui/design-system';
import { createFakeWebExt } from '../unit/platform/_fake-webext';
import { createFakeSettingsClient } from '../unit/ui/settings/_fixtures';
import { byName, flush, render } from '../unit/ui/_render';
import { mediaItem } from '../unit/runtime/_fixtures';

const NO_MEDIA_QUERIES: MediaPreferences = {
  matches: () => false,
  subscribe: () => () => undefined,
};

describe('regression: Firefox menus permission (Phase 9)', () => {
  it('declares no menus permission on Firefox, and none at install either', () => {
    const optional = optionalPermissionsFor('firefox');

    expect(optional).toEqual(['notifications']);
    expect(optional).not.toContain('menus');

    const manifest = generateManifest({ target: 'firefox', mode: 'production', version: '0.1.0' });
    expect(manifest.optional_permissions).toEqual(['notifications']);
    // Least privilege: it is not silently promoted into the install-time set.
    expect(manifest.permissions).not.toContain('menus');
    expect(manifest.permissions).not.toContain('contextMenus');
  });

  it('keeps the Chromium context-menu permission exactly as it was', () => {
    const manifest = generateManifest({ target: 'chrome', mode: 'production', version: '0.1.0' });
    expect(manifest.optional_permissions).toEqual(['notifications', 'contextMenus']);
    expect(manifest.permissions).not.toContain('contextMenus');
  });

  it('reports the capability honestly to a surface on each target', () => {
    const firefox = createSettingsRuntimeClient(
      createBrowserFrom(createFakeWebExt({ firefox: true }).api, 'firefox'),
    );
    const chromium = createSettingsRuntimeClient(
      createBrowserFrom(createFakeWebExt({ contextMenus: true }).api, 'chrome'),
    );

    expect(firefox.supportsPermission('contextMenus')).toBe(false);
    expect(firefox.supportsPermission('notifications')).toBe(true);
    expect(chromium.supportsPermission('contextMenus')).toBe(true);
  });

  it('projects the running manifest, so nothing has to sniff the browser', () => {
    const fake = createFakeWebExt({ firefox: true });
    expect(readManifest(fake.api).optionalPermissions).toEqual(['notifications']);
  });

  it('offers no context-menu controls on a browser that cannot provide them', async () => {
    const fake = createFakeSettingsClient();
    fake.supported.delete('contextMenus');

    const view = render(
      <SettingsApp client={fake.client} media={NO_MEDIA_QUERIES} locale="en-US" />,
    );
    await flush();

    // No dead grant button, and no preference that could not take effect.
    expect(byName(view.container, 'Grant: Context menu')).toBeUndefined();
    expect(byName(view.container, 'Revoke: Context menu')).toBeUndefined();
    expect(view.container.textContent).not.toContain('Context menu entries');
    // The permission is never even queried there.
    expect(fake.calls.filter((call) => call.includes('contextMenus'))).toEqual([]);
    // Notifications, which Firefox does offer, are unaffected.
    expect(byName(view.container, 'Grant: Notifications')).toBeDefined();

    view.unmount();
  });

  it('still offers them on a browser that can', async () => {
    const fake = createFakeSettingsClient();

    const view = render(
      <SettingsApp client={fake.client} media={NO_MEDIA_QUERIES} locale="en-US" />,
    );
    await flush();

    expect(byName(view.container, 'Grant: Context menu')).toBeDefined();
    view.unmount();
  });

  it('leaves the background menu runtime inert on Firefox without failing', async () => {
    const fake = createFakeWebExt({ firefox: true });
    const errors: unknown[] = [];
    const browser = createBrowserFrom(fake.api, 'firefox');

    // No `menus` namespace: the facade omits it, so the feature is simply absent.
    expect(browser.menus).toBeUndefined();
    expect(browser.capabilities.contextMenus).toBe(false);

    const runtime = createContextMenuRuntime({
      browser,
      getSettings: () => Promise.resolve({ ...DEFAULT_SETTINGS, contextMenu: true }),
      getActiveItems: () => [mediaItem({ id: 'clip' })],
      enqueue: () => Promise.resolve(),
      entryTitle: (item) => item.title,
      onError: (error) => errors.push(error),
    });
    runtime.start();
    await runtime.sync();

    // Graceful: nothing registered, nothing thrown, nothing reported as broken.
    expect(fake.menuItems.size).toBe(0);
    expect(errors).toEqual([]);
    await runtime.dispose();
  });
});
