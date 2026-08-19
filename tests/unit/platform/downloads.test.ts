import { describe, expect, it, vi } from 'vitest';
import { createDownloadsService } from '@platform/downloads/service';
import { createFakeWebExt } from './_fake-webext';

describe('platform/downloads service', () => {
  it('starts a download and reports progress', async () => {
    const fake = createFakeWebExt();
    const downloads = createDownloadsService(fake.api);
    const id = await downloads.start({
      url: 'https://ex.com/a.mp4',
      filename: 'a.mp4',
      conflictAction: 'uniquify',
      saveAs: false,
    });
    expect(id).toBe(1);

    const progress = await downloads.getProgress(1);
    expect(progress).toEqual({ id: 1, state: 'active', bytesReceived: 0, bytesTotal: 100 });

    expect(await downloads.getProgress(999)).toBeUndefined();
  });

  it('cancels a download', async () => {
    const fake = createFakeWebExt();
    const downloads = createDownloadsService(fake.api);
    const id = await downloads.start({
      url: 'https://ex.com/a.mp4',
      filename: 'a.mp4',
      conflictAction: 'uniquify',
      saveAs: false,
    });
    await downloads.cancel(id);
    expect((await downloads.getProgress(id))?.state).toBe('failed');
  });

  it('maps state-change notifications and detaches', () => {
    const fake = createFakeWebExt();
    const downloads = createDownloadsService(fake.api);
    const listener = vi.fn();
    const off = downloads.onChanged(listener);
    expect(fake.onDownloadChanged.size).toBe(1);

    fake.onDownloadChanged.trigger({ id: 1, state: { current: 'complete' } });
    expect(listener).toHaveBeenCalledWith({ id: 1, state: 'completed' });

    fake.onDownloadChanged.trigger({ id: 1, state: { current: 'unknown-state' } });
    expect(listener).toHaveBeenLastCalledWith({ id: 1, state: undefined });

    off();
    expect(fake.onDownloadChanged.size).toBe(0);
  });
});
