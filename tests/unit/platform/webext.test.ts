import { afterEach, describe, expect, it } from 'vitest';
import { detectTarget, resolveWebExtApi } from '@platform/browser/webext';
import { RuntimeError } from '@shared/result/errors';
import { createFakeWebExt } from './_fake-webext';

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'chrome');
  Reflect.deleteProperty(globalThis, 'browser');
});

describe('platform/browser webext normalization', () => {
  it('detectTarget distinguishes firefox from chromium by capability', () => {
    expect(detectTarget(createFakeWebExt({ firefox: true }).api)).toBe('firefox');
    expect(detectTarget(createFakeWebExt().api)).toBe('chrome');
  });

  it('resolves the Chromium `chrome` global', () => {
    Reflect.set(globalThis, 'chrome', createFakeWebExt().api);
    expect(resolveWebExtApi().target).toBe('chrome');
  });

  it('prefers the Firefox `browser` global over `chrome` when both are present', () => {
    // Firefox exposes BOTH namespaces; the `browser ?? chrome` ordering must win.
    Reflect.set(globalThis, 'chrome', createFakeWebExt().api);
    Reflect.set(globalThis, 'browser', createFakeWebExt({ firefox: true }).api);
    expect(resolveWebExtApi().target).toBe('firefox');
  });

  it('throws RuntimeError when no WebExtension API is present', () => {
    expect(() => resolveWebExtApi()).toThrow(RuntimeError);
  });
});
