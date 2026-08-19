import { describe, expect, it } from 'vitest';
import type { DownloadTask } from '@shared/types';
import { createDownloadQueue } from '@core/download/queue/queue';
import { createInMemoryQueueRepository } from '@core/storage/memory';
import { mediaItem } from './_fixtures';

function task(props: Partial<DownloadTask> & Pick<DownloadTask, 'id'>): DownloadTask {
  return {
    item: mediaItem(),
    state: 'queued',
    filename: 'f.mp4',
    attempt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...props,
  };
}

describe('download queue', () => {
  it('adds, inspects, and removes jobs', async () => {
    const queue = createDownloadQueue();
    await queue.add(task({ id: 'a' }));
    await queue.add(task({ id: 'b' }));
    expect(queue.size).toBe(2);
    expect(queue.getById('a')?.id).toBe('a');
    expect(queue.list()).toHaveLength(2);
    await queue.remove('a');
    expect(queue.getById('a')).toBeUndefined();
    expect(queue.size).toBe(1);
  });

  it('nextQueued picks highest priority then FIFO (createdAt)', async () => {
    const queue = createDownloadQueue();
    await queue.add(task({ id: 'a', priority: 0, createdAt: 1 }));
    await queue.add(task({ id: 'b', priority: 5, createdAt: 2 }));
    await queue.add(task({ id: 'c', priority: 5, createdAt: 0 }));
    expect(queue.nextQueued()?.id).toBe('c');
    await queue.update(task({ id: 'c', priority: 5, createdAt: 0, state: 'active' }));
    expect(queue.nextQueued()?.id).toBe('b');
  });

  it('reports state buckets and stats', async () => {
    const queue = createDownloadQueue();
    await queue.add(task({ id: 'a', state: 'queued' }));
    await queue.add(task({ id: 'b', state: 'active' }));
    await queue.add(task({ id: 'c', state: 'completed' }));
    expect(queue.byState('active').map((t) => t.id)).toEqual(['b']);
    const stats = queue.stats();
    expect(stats.total).toBe(3);
    expect(stats.queued).toBe(1);
    expect(stats.active).toBe(1);
    expect(stats.completed).toBe(1);
  });

  it('persists to the repository and rehydrates, requeuing interrupted jobs (§8.9)', async () => {
    const repository = createInMemoryQueueRepository();
    const first = createDownloadQueue({ repository });
    await first.add(task({ id: 'q', state: 'queued' }));
    await first.add(task({ id: 'a', state: 'active', nativeDownloadId: 7 }));
    await first.add(task({ id: 'done', state: 'completed' }));

    const second = createDownloadQueue({ repository });
    await second.hydrate();
    expect(second.getById('q')?.state).toBe('queued');
    // The interrupted active job is recovered to queued, dropping the stale id.
    expect(second.getById('a')?.state).toBe('queued');
    expect(second.getById('a')?.nativeDownloadId).toBeUndefined();
    // Completed jobs are restored as-is.
    expect(second.getById('done')?.state).toBe('completed');
  });

  it('finalizes an interrupted canceling job to canceled on hydrate — never resurrects a cancel (§6)', async () => {
    const repository = createInMemoryQueueRepository();
    const first = createDownloadQueue({ repository });
    await first.add(task({ id: 'c', state: 'canceling', nativeDownloadId: 9 }));

    const second = createDownloadQueue({ repository });
    await second.hydrate();
    expect(second.getById('c')?.state).toBe('canceled');
    expect(second.getById('c')?.nativeDownloadId).toBeUndefined();
  });
});
