import { describe, expect, it } from 'vitest';
import { isChromium, isFirefox } from '@platform/browser/detect';
import { createFakeWebExt } from './_fake-webext';

describe('platform/browser detect', () => {
  it('isFirefox / isChromium reflect the resolved API family', () => {
    const firefox = createFakeWebExt({ firefox: true }).api;
    const chromium = createFakeWebExt().api;
    expect(isFirefox(firefox)).toBe(true);
    expect(isChromium(firefox)).toBe(false);
    expect(isChromium(chromium)).toBe(true);
    expect(isFirefox(chromium)).toBe(false);
  });
});
