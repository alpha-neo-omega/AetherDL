import { describe, expect, it } from 'vitest';
import { createScriptingService } from '@platform/scripting/service';
import type { WebExtApi } from '@platform/browser/webext';
import { PlatformError } from '@shared/result/errors';
import { createFakeWebExt } from './_fake-webext';

describe('scripting adapter', () => {
  it('executes a script injection and returns per-frame results', async () => {
    const fake = createFakeWebExt();
    const scripting = createScriptingService(fake.api);
    const results = await scripting.executeScript({
      target: { tabId: 5, allFrames: false },
      files: ['content.js'],
    });
    expect(results).toEqual([{ frameId: 0 }]);
    expect(fake.scripting.executed).toHaveLength(1);
    expect(fake.scripting.executed[0]?.target.tabId).toBe(5);
    expect(fake.scripting.executed[0]?.files).toEqual(['content.js']);
  });

  it('registers content scripts in the ISOLATED world only (§13.6)', async () => {
    const fake = createFakeWebExt();
    const scripting = createScriptingService(fake.api);
    await scripting.registerContentScripts([
      { id: 'aether-observer', matches: ['https://example.com/*'], js: ['content.js'] },
    ]);
    expect(fake.scripting.registered).toHaveLength(1);
    expect(fake.scripting.registered[0]?.world).toBe('ISOLATED');
    expect(fake.scripting.registered[0]?.id).toBe('aether-observer');
  });

  it('unregisters content scripts by filter', async () => {
    const fake = createFakeWebExt();
    const scripting = createScriptingService(fake.api);
    await scripting.unregisterContentScripts({ ids: ['aether-observer'] });
    await scripting.unregisterContentScripts();
    expect(fake.scripting.unregistered[0]).toEqual({ ids: ['aether-observer'] });
    expect(fake.scripting.unregistered[1]).toBeUndefined();
  });

  it('maps optional registration fields and injection frame targets', async () => {
    const fake = createFakeWebExt();
    const scripting = createScriptingService(fake.api);
    await scripting.executeScript({ target: { tabId: 1, frameIds: [0, 2] }, files: ['c.js'] });
    await scripting.registerContentScripts([
      {
        id: 'x',
        matches: ['*://*/*'],
        js: ['c.js'],
        runAt: 'document_idle',
        allFrames: true,
        persistAcrossSessions: false,
      },
    ]);
    expect(fake.scripting.executed[0]?.target.frameIds).toEqual([0, 2]);
    const reg = fake.scripting.registered[0]!;
    expect(reg.runAt).toBe('document_idle');
    expect(reg.allFrames).toBe(true);
    expect(reg.persistAcrossSessions).toBe(false);
    expect(reg.js).toEqual(['c.js']);
  });

  it('maps a native injection result payload', async () => {
    const fake = createFakeWebExt();
    const withResult: WebExtApi = {
      ...fake.api,
      scripting: {
        ...fake.api.scripting!,
        executeScript: async () => [{ frameId: 2, result: 'ok' }],
      },
    };
    const scripting = createScriptingService(withResult);
    const results = await scripting.executeScript({ target: { tabId: 1 }, files: ['c.js'] });
    expect(results[0]).toEqual({ frameId: 2, result: 'ok' });
  });

  it('wraps execute/register/unregister failures as PlatformError', async () => {
    const fake = createFakeWebExt();
    const failing: WebExtApi = {
      ...fake.api,
      scripting: {
        executeScript: () => Promise.reject(new Error('e')),
        registerContentScripts: () => Promise.reject(new Error('r')),
        unregisterContentScripts: () => Promise.reject(new Error('u')),
      },
    };
    const scripting = createScriptingService(failing);
    await expect(
      scripting.executeScript({ target: { tabId: 1 }, files: ['c.js'] }),
    ).rejects.toBeInstanceOf(PlatformError);
    await expect(
      scripting.registerContentScripts([{ id: 'x', matches: ['*://*/*'] }]),
    ).rejects.toBeInstanceOf(PlatformError);
    await expect(scripting.unregisterContentScripts()).rejects.toBeInstanceOf(PlatformError);
  });

  it('throws a typed PlatformError when the scripting namespace is absent', async () => {
    const fake = createFakeWebExt();
    const noScripting: WebExtApi = { ...fake.api };
    delete noScripting.scripting;
    const scripting = createScriptingService(noScripting);
    await expect(
      scripting.executeScript({ target: { tabId: 1 }, files: ['content.js'] }),
    ).rejects.toBeInstanceOf(PlatformError);
  });
});
