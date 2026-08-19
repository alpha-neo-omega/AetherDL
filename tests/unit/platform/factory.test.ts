import { afterEach, describe, expect, it } from 'vitest';
import {
  createBrowser,
  createBrowserFrom,
  createChromiumBrowser,
  createFirefoxBrowser,
} from '@platform/browser/factory';
import { createFakeWebExt } from './_fake-webext';

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'chrome');
  Reflect.deleteProperty(globalThis, 'browser');
});

describe('platform/browser factory', () => {
  it('assembles the facade with all six services', () => {
    const browser = createBrowserFrom(
      createFakeWebExt({ firefox: true, withSession: true }).api,
      'firefox',
    );
    expect(browser.target).toBe('firefox');
    expect(browser.capabilities.sessionStorage).toBe(true);
    expect(browser.runtime).toBeDefined();
    expect(browser.tabs).toBeDefined();
    expect(browser.downloads).toBeDefined();
    expect(browser.storage).toBeDefined();
    expect(browser.permissions).toBeDefined();
    expect(browser.messaging).toBeDefined();
    // Out-of-scope adapters are absent in Phase 2 builds.
    expect(browser.notifications).toBeUndefined();
    expect(browser.network).toBeUndefined();
  });

  it('named per-target adapters pin the target', () => {
    expect(createChromiumBrowser(createFakeWebExt().api).target).toBe('chrome');
    expect(createFirefoxBrowser(createFakeWebExt({ firefox: true }).api).target).toBe('firefox');
  });

  it('createBrowser auto-detects the ambient namespace', () => {
    Reflect.set(globalThis, 'chrome', createFakeWebExt().api);
    expect(createBrowser().target).toBe('chrome');
  });
});
