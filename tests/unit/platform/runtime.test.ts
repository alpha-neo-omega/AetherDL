import { describe, expect, it, vi } from 'vitest';
import { createRuntimeService } from '@platform/browser/runtime';
import { createFakeWebExt } from './_fake-webext';

describe('platform/browser runtime service', () => {
  it('exposes id, manifest, version, and URL', () => {
    const fake = createFakeWebExt({ firefox: true, manifestVersion: '0.1.0', extensionId: 'abc' });
    const runtime = createRuntimeService(fake.api, 'firefox');
    expect(runtime.id).toBe('abc');
    expect(runtime.getVersion()).toBe('0.1.0');
    expect(runtime.getManifest().name).toBe('AetherDL');
    expect(runtime.getURL('popup.html')).toContain('popup.html');
  });

  it('returns Firefox browser info via getBrowserInfo', async () => {
    const fake = createFakeWebExt({ firefox: true });
    const runtime = createRuntimeService(fake.api, 'firefox');
    const info = await runtime.getBrowserInfo();
    expect(info).toEqual({ name: 'Firefox', version: '128.0', target: 'firefox' });
  });

  it('derives Chromium browser info from the manifest', async () => {
    const fake = createFakeWebExt({ manifestVersion: '0.1.0' });
    const runtime = createRuntimeService(fake.api, 'chrome');
    const info = await runtime.getBrowserInfo();
    expect(info).toEqual({ name: 'Chromium', version: '0.1.0', target: 'chrome' });
  });

  it('fires and detaches lifecycle hooks', () => {
    const fake = createFakeWebExt();
    const runtime = createRuntimeService(fake.api, 'chrome');

    const installed = vi.fn();
    const offInstalled = runtime.onInstalled(installed);
    fake.onInstalled.trigger({ reason: 'install', previousVersion: '0.0.9' });
    expect(installed).toHaveBeenCalledWith({ reason: 'install', previousVersion: '0.0.9' });

    fake.onInstalled.trigger({});
    expect(installed).toHaveBeenLastCalledWith({ reason: 'unknown', previousVersion: undefined });

    offInstalled();
    expect(fake.onInstalled.size).toBe(0);

    const startup = vi.fn();
    const offStartup = runtime.onStartup(startup);
    fake.onStartup.trigger();
    expect(startup).toHaveBeenCalledOnce();
    offStartup();
    expect(fake.onStartup.size).toBe(0);
  });
});
