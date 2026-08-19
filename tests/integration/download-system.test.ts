/**
 * Integration: the fully-wired download system (createDownloadSystem) over a fake
 * DownloadsAdapter — the composition the background will build with the real Phase 2
 * adapter (PROJECT_BIBLE.md §10, §16.2).
 */
import { describe, expect, it, vi } from 'vitest';
import { createDownloadSystem } from '@core/download/factory';
import { createInMemoryQueueRepository } from '@core/storage/memory';
import { createFakeDownloads, mediaItem, tick } from '../unit/core/download/_fixtures';

describe('download system (integration)', () => {
  it('persists enqueued jobs through the queue repository (§8.14)', async () => {
    const repository = createInMemoryQueueRepository();
    const fake = createFakeDownloads();
    const manager = createDownloadSystem({
      downloads: fake.adapter,
      queueRepository: repository,
      clock: () => 0,
    });
    manager.pauseQueue();
    await manager.enqueue([mediaItem({ url: 'https://example.com/a.mp4' })]);

    const persisted = await repository.load();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.state).toBe('queued');
    await manager.dispose();
  });

  it('drives a job to completion and emits queue:completed', async () => {
    const fake = createFakeDownloads();
    const completed = vi.fn();
    const queueCompleted = vi.fn();
    const manager = createDownloadSystem({
      downloads: fake.adapter,
      clock: () => 1000,
      maxConcurrent: 1,
    });
    manager.on('job:completed', completed);
    manager.on('queue:completed', queueCompleted);

    const [job] = await manager.enqueue([mediaItem({ url: 'https://example.com/a.mp4' })]);
    await tick();
    const nativeId = manager.getTask(job!.id)!.nativeDownloadId!;
    fake.setItem(nativeId, { state: 'completed', bytesReceived: 100 });
    fake.emit({ id: nativeId, state: 'completed' });
    await tick();

    expect(manager.getTask(job!.id)?.state).toBe('completed');
    expect(completed).toHaveBeenCalledTimes(1);
    expect(queueCompleted).toHaveBeenCalledWith({ completed: 1, failed: 0, canceled: 0 });
    await manager.dispose();
  });

  it('refuses DRM/stream media at enqueue (no native start) (§6)', async () => {
    const fake = createFakeDownloads();
    const manager = createDownloadSystem({ downloads: fake.adapter, clock: () => 0 });
    await manager.enqueue([
      mediaItem({
        url: 'https://example.com/drm.mp4',
        status: 'unsupported',
        unsupportedReason: 'DRM',
      }),
      mediaItem({ url: 'https://example.com/live.mpd', delivery: 'dash', kind: 'stream' }),
      mediaItem({ url: 'blob:https://example.com/x', delivery: 'blob' }),
    ]);
    await tick();
    expect(fake.started).toHaveLength(0);
    expect(manager.stats().failed).toBe(3);
    await manager.dispose();
  });

  it('strips path traversal from the configured download subfolder (§13.5)', async () => {
    const fake = createFakeDownloads();
    const manager = createDownloadSystem({
      downloads: fake.adapter,
      clock: () => 0,
      maxConcurrent: 1,
      downloadSubfolder: '../../Desktop/../secret',
    });
    await manager.enqueue([
      mediaItem({ url: 'https://example.com/a.mp4', title: 'a', extension: 'mp4' }),
    ]);
    await tick();
    const target = fake.started[0]?.filename ?? '';
    expect(target).not.toContain('..');
    expect(target.startsWith('/')).toBe(false);
    // Traversal segments dropped; benign segments preserved as a nested folder.
    expect(target).toContain('Desktop/');
    expect(target).toContain('secret/');
    await manager.dispose();
  });
});
