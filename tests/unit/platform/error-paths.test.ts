/**
 * Verifies that every platform service maps underlying WebExtension failures to the
 * correct typed PlatformError (PROJECT_BIBLE.md §20). Covers the error branches that
 * the happy-path specs do not exercise.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createDownloadsService } from '@platform/downloads/service';
import { createMessageBus } from '@platform/messaging/service';
import { createPermissionsService } from '@platform/permissions/service';
import { createStorageService } from '@platform/storage/service';
import { createTabsService } from '@platform/tabs/service';
import { resolveWebExtApi } from '@platform/browser/webext';
import {
  DownloadError,
  PermissionError,
  RuntimeError,
  StorageError,
  TabError,
} from '@shared/result/errors';
import { createFakeWebExt } from './_fake-webext';

const reject = async (): Promise<never> => {
  throw new Error('underlying failure');
};

describe('platform error propagation', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'chrome');
    Reflect.deleteProperty(globalThis, 'browser');
  });

  it('tabs → TabError', async () => {
    const fake = createFakeWebExt();
    fake.api.tabs.query = reject;
    fake.api.windows.getCurrent = reject;
    const tabs = createTabsService(fake.api);
    await expect(tabs.getActive()).rejects.toBeInstanceOf(TabError);
    await expect(tabs.getCurrentWindow()).rejects.toBeInstanceOf(TabError);
  });

  it('downloads → DownloadError', async () => {
    const fake = createFakeWebExt();
    fake.api.downloads.download = reject;
    fake.api.downloads.cancel = reject;
    fake.api.downloads.search = reject;
    const downloads = createDownloadsService(fake.api);
    await expect(
      downloads.start({ url: 'x', filename: 'f', conflictAction: 'uniquify', saveAs: false }),
    ).rejects.toBeInstanceOf(DownloadError);
    await expect(downloads.cancel(1)).rejects.toBeInstanceOf(DownloadError);
    await expect(downloads.getProgress(1)).rejects.toBeInstanceOf(DownloadError);
  });

  it('permissions → PermissionError', async () => {
    const fake = createFakeWebExt();
    fake.api.permissions.contains = reject;
    fake.api.permissions.request = reject;
    fake.api.permissions.remove = reject;
    fake.api.permissions.getAll = reject;
    const permissions = createPermissionsService(fake.api);
    await expect(permissions.contains(['a'])).rejects.toBeInstanceOf(PermissionError);
    await expect(permissions.request(['a'])).rejects.toBeInstanceOf(PermissionError);
    await expect(permissions.remove(['a'])).rejects.toBeInstanceOf(PermissionError);
    await expect(permissions.containsHosts(['o'])).rejects.toBeInstanceOf(PermissionError);
    await expect(permissions.requestHosts(['o'])).rejects.toBeInstanceOf(PermissionError);
    await expect(permissions.removeHosts(['o'])).rejects.toBeInstanceOf(PermissionError);
    await expect(permissions.getAll()).rejects.toBeInstanceOf(PermissionError);
  });

  it('storage → StorageError', async () => {
    const fake = createFakeWebExt();
    fake.api.storage.local.get = reject;
    fake.api.storage.local.set = reject;
    fake.api.storage.local.remove = reject;
    fake.api.storage.local.clear = reject;
    const storage = createStorageService(fake.api);
    await expect(storage.local.get('k')).rejects.toBeInstanceOf(StorageError);
    await expect(storage.local.set('k', 1)).rejects.toBeInstanceOf(StorageError);
    await expect(storage.local.getMany(['k'])).rejects.toBeInstanceOf(StorageError);
    await expect(storage.local.setMany({ k: 1 })).rejects.toBeInstanceOf(StorageError);
    await expect(storage.local.remove('k')).rejects.toBeInstanceOf(StorageError);
    await expect(storage.local.clear()).rejects.toBeInstanceOf(StorageError);
  });

  it('messaging → MessagingError for transport failure and invalid response', async () => {
    const transportFake = createFakeWebExt();
    transportFake.api.runtime.sendMessage = reject;
    const transportBus = createMessageBus(transportFake.api);
    await expect(transportBus.send('download/enqueue', { itemIds: [] })).rejects.toMatchObject({
      code: 'messaging-transport-failed',
    });

    const invalidFake = createFakeWebExt();
    invalidFake.api.runtime.sendMessage = async () => ({ garbage: true });
    const invalidBus = createMessageBus(invalidFake.api);
    await expect(invalidBus.send('download/enqueue', { itemIds: [] })).rejects.toMatchObject({
      code: 'messaging-no-response',
    });
  });

  it('webext → RuntimeError when the runtime API is incomplete', () => {
    Reflect.set(globalThis, 'chrome', { runtime: {} });
    expect(() => resolveWebExtApi()).toThrow(RuntimeError);
  });
});
