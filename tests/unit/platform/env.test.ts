import { describe, expect, it } from 'vitest';
import { describeEnvironment } from '@platform/browser/env';
import { createFakeWebExt } from './_fake-webext';

describe('platform/browser env', () => {
  it('describes the runtime platform environment', () => {
    const env = describeEnvironment(
      createFakeWebExt({ firefox: true, withSession: true, manifestVersion: '0.1.0' }).api,
      'firefox',
    );
    expect(env.target).toBe('firefox');
    expect(env.extensionVersion).toBe('0.1.0');
    expect(env.capabilities.sessionStorage).toBe(true);
    expect(env.capabilities.browserInfo).toBe(true);
  });
});
