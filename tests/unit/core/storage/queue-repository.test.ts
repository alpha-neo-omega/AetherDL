import { describe, expect, it, vi } from 'vitest';
import type { AppError } from '@shared/result';
import { createDownloadQueue } from '@core/download/queue/queue';
import {
  createQueueRepository,
  QUEUE_DATABASE_NAME,
  QUEUE_STORE_NAME,
} from '@core/storage/queue-repository';
import { createMemoryObjectStore, downloadTask, mediaItem } from './_fixtures';

function setup(): {
  readonly store: ReturnType<typeof createMemoryObjectStore>;
  readonly errors: AppError[];
  readonly repository: ReturnType<typeof createQueueRepository>;
} {
  const store = createMemoryObjectStore();
  const errors: AppError[] = [];
  const repository = createQueueRepository({
    store,
    onError: (error) => {
      errors.push(error);
    },
  });
  return { store, errors, repository };
}

describe('core/storage durable queue repository', () => {
  it('names a single versioned store in its own database', () => {
    // Its own database, not one shared with history: a shared database would need a
    // schema version both adapters agree on, and neither knows the other's store.
    expect(QUEUE_DATABASE_NAME).toBe('aetherdl-queue');
    expect(QUEUE_STORE_NAME).toBe('download-queue');
  });

  it('round-trips the queue metadata a restart needs', async () => {
    const { repository } = setup();
    const task = downloadTask({
      id: 'job-1',
      state: 'paused',
      filename: 'Clip.mp4',
      originalFilename: 'Clip.mp4',
      priority: 2,
      attempt: 1,
      bytesTotal: 4096,
      startedAt: 50,
      completedAt: 60,
    });

    await repository.save([task]);
    const [loaded] = await repository.load();

    expect(loaded).toEqual(task);
  });

  it('never persists the native handle or in-flight transfer counters', async () => {
    const { store, repository } = setup();
    await repository.save([
      downloadTask({
        id: 'job-1',
        state: 'active',
        nativeDownloadId: 77,
        bytesReceived: 512,
        bytesTotal: 1024,
        progress: 0.5,
      }),
    ]);

    const record = store.records.get('job-1') as Record<string, unknown>;
    expect(record['nativeDownloadId']).toBeUndefined();
    expect(record['bytesReceived']).toBeUndefined();
    expect(record['progress']).toBeUndefined();
    // Total size is job metadata, not an in-flight counter — it survives.
    expect(record['bytesTotal']).toBe(1024);
  });

  it('persists an error without its local-only diagnostics', async () => {
    const { store, repository } = setup();
    const error: AppError = {
      category: 'network',
      code: 'net-timeout',
      messageKey: 'error.network',
      retryable: true,
      cause: new Error('socket'),
      context: { url: 'https://example.com/v.mp4' },
    };

    await repository.save([downloadTask({ id: 'job-1', state: 'failed', error })]);
    const record = store.records.get('job-1') as { readonly error: AppError };

    expect(record.error).toEqual({
      category: 'network',
      code: 'net-timeout',
      messageKey: 'error.network',
      retryable: true,
    });
    const [loaded] = await repository.load();
    expect(loaded?.error?.retryable).toBe(true);
  });

  it('keeps optional job metadata that is set', async () => {
    const { repository } = setup();
    await repository.save([downloadTask({ id: 'job-1', metadata: { source: 'context-menu' } })]);
    const [loaded] = await repository.load();
    expect(loaded?.metadata).toEqual({ source: 'context-menu' });
  });

  it('deletes records for jobs that left the queue', async () => {
    const { store, repository } = setup();
    await repository.save([downloadTask({ id: 'a' }), downloadTask({ id: 'b' })]);
    await repository.save([downloadTask({ id: 'b' })]);

    expect([...store.records.keys()]).toEqual(['b']);
  });

  it('deletes stale records before writing current ones', async () => {
    const { store, repository } = setup();
    await repository.save([downloadTask({ id: 'a' })]);
    store.calls.length = 0;
    await repository.save([downloadTask({ id: 'b' })]);

    expect(store.calls).toEqual(['delete:a', 'put:b']);
  });

  it('reconciles against the existing store when save runs before load', async () => {
    const { store, repository } = setup();
    store.records.set('ghost', {
      id: 'ghost',
      item: mediaItem(),
      state: 'queued',
      filename: 'Ghost.mp4',
      attempt: 0,
      createdAt: 1,
      updatedAt: 1,
    });

    await repository.save([downloadTask({ id: 'a' })]);

    expect([...store.records.keys()]).toEqual(['a']);
  });

  it('drops malformed records on load and reports the loss', async () => {
    const { store, errors, repository } = setup();
    store.records.set('good', {
      id: 'good',
      item: mediaItem(),
      state: 'queued',
      filename: 'Good.mp4',
      attempt: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    store.records.set('bad-state', {
      id: 'bad-state',
      item: mediaItem(),
      state: 'nonsense',
      filename: 'Bad.mp4',
      attempt: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    store.records.set('bad-item', {
      id: 'bad-item',
      item: { id: 'x' },
      state: 'queued',
      filename: 'Bad.mp4',
      attempt: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    store.records.set('not-an-object', 42);
    store.records.set('item-not-an-object', {
      id: 'item-not-an-object',
      item: 'nope',
      state: 'queued',
      filename: 'Bad.mp4',
      attempt: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    store.records.set('error-not-an-object', {
      id: 'error-not-an-object',
      item: mediaItem(),
      state: 'failed',
      filename: 'Bad.mp4',
      attempt: 0,
      createdAt: 1,
      updatedAt: 1,
      error: 'boom',
    });

    const loaded = await repository.load();

    expect(loaded.map((task) => task.id)).toEqual(['good']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ category: 'storage', code: 'queue-load-validate-failed' });
  });

  it('rejects a record whose optional fields have the wrong type', async () => {
    const { store, repository } = setup();
    store.records.set('bad', {
      id: 'bad',
      item: mediaItem(),
      state: 'queued',
      filename: 'Bad.mp4',
      attempt: 0,
      createdAt: 1,
      updatedAt: 1,
      priority: 'high',
    });
    expect(await repository.load()).toEqual([]);
  });

  it('rejects a record carrying a malformed error', async () => {
    const { store, repository } = setup();
    store.records.set('bad', {
      id: 'bad',
      item: mediaItem(),
      state: 'queued',
      filename: 'Bad.mp4',
      attempt: 0,
      createdAt: 1,
      updatedAt: 1,
      error: { category: 'made-up', code: 'x', messageKey: 'k', retryable: false },
    });
    expect(await repository.load()).toEqual([]);
  });

  it('reports a load failure, returns nothing, and never throws', async () => {
    const { store, errors, repository } = setup();
    store.failing.add('getAll');

    await expect(repository.load()).resolves.toEqual([]);
    expect(errors[0]).toMatchObject({ category: 'storage', code: 'queue-load-failed' });
  });

  it('skips saving after a failed load so unreadable data is not overwritten', async () => {
    const { store, repository } = setup();
    store.records.set('existing', {
      id: 'existing',
      item: mediaItem(),
      state: 'queued',
      filename: 'Existing.mp4',
      attempt: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    store.failing.add('getAll');
    await repository.load();

    await repository.save([downloadTask({ id: 'new' })]);

    expect([...store.records.keys()]).toEqual(['existing']);
  });

  it('resumes saving once a later load succeeds', async () => {
    const { store, repository } = setup();
    store.failing.add('getAll');
    await repository.load();
    store.failing.clear();
    await repository.load();

    await repository.save([downloadTask({ id: 'new' })]);

    expect([...store.records.keys()]).toEqual(['new']);
  });

  it('reports a save failure and never throws', async () => {
    const { store, errors, repository } = setup();
    await repository.load();
    store.failing.add('put');

    await expect(repository.save([downloadTask({ id: 'a' })])).resolves.toBeUndefined();
    expect(errors[0]).toMatchObject({ category: 'storage', code: 'queue-save-failed' });
  });

  it('re-reconciles from the store after a failed save', async () => {
    const { store, repository } = setup();
    await repository.load();
    await repository.save([downloadTask({ id: 'a' })]);
    store.failing.add('put');
    await repository.save([downloadTask({ id: 'b' })]);
    store.failing.clear();
    store.calls.length = 0;

    await repository.save([downloadTask({ id: 'c' })]);

    expect(store.calls[0]).toBe('getAll:*');
    expect([...store.records.keys()]).toEqual(['c']);
  });

  it('reconstructs the queue through the existing hydrate recovery behavior', async () => {
    const { repository } = setup();
    const writer = createDownloadQueue({ repository });
    await writer.add(downloadTask({ id: 'live', state: 'queued' }));
    await writer.update(
      downloadTask({ id: 'live', state: 'active', nativeDownloadId: 12, progress: 0.4 }),
    );
    await writer.add(downloadTask({ id: 'stopping', state: 'canceling', nativeDownloadId: 13 }));
    await writer.add(downloadTask({ id: 'done', state: 'completed' }));

    // A fresh process: same durable store, brand-new in-memory queue.
    const reloaded = createDownloadQueue({ repository });
    await reloaded.hydrate();

    expect(reloaded.getById('live')?.state).toBe('queued');
    expect(reloaded.getById('live')?.nativeDownloadId).toBeUndefined();
    expect(reloaded.getById('stopping')?.state).toBe('canceled');
    expect(reloaded.getById('done')?.state).toBe('completed');
  });

  it('is safe to construct with a store that is never touched', () => {
    const onError = vi.fn();
    const repository = createQueueRepository({ store: createMemoryObjectStore(), onError });
    expect(repository.load).toBeTypeOf('function');
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('queue repository: a save writes only what changed (§12.1)', () => {
  it('rewrites one record when one job changed, not the whole queue', async () => {
    // Regression: `save` is called on every queue mutation, and it used to put every
    // task each time — a hundred writes to move one progress number.
    const store = createMemoryObjectStore();
    const repository = createQueueRepository({ store, onError: () => undefined });
    const tasks = [
      downloadTask({ id: 'a' }),
      downloadTask({ id: 'b' }),
      downloadTask({ id: 'c' }),
      downloadTask({ id: 'd' }),
      downloadTask({ id: 'e' }),
    ];

    await repository.save(tasks);
    const initialPuts = store.calls.filter((call) => call.startsWith('put:')).length;
    expect(initialPuts).toBe(5);

    await repository.save([{ ...downloadTask({ id: 'a' }), bytesTotal: 4096 }, ...tasks.slice(1)]);

    const puts = store.calls.filter((call) => call.startsWith('put:')).slice(initialPuts);
    expect(puts).toEqual(['put:a']);
  });

  it('writes nothing at all when nothing changed', async () => {
    const store = createMemoryObjectStore();
    const repository = createQueueRepository({ store, onError: () => undefined });
    const tasks = [downloadTask({ id: 'a' }), downloadTask({ id: 'b' })];

    await repository.save(tasks);
    const before = store.calls.length;
    await repository.save(tasks);

    expect(store.calls.slice(before)).toEqual([]);
  });

  it('still removes a job that left the queue', async () => {
    const store = createMemoryObjectStore();
    const repository = createQueueRepository({ store, onError: () => undefined });

    await repository.save([downloadTask({ id: 'a' }), downloadTask({ id: 'b' })]);
    await repository.save([downloadTask({ id: 'a' })]);

    expect([...store.records.keys()]).toEqual(['a']);
  });

  it('re-reconciles from the store after a failed save', async () => {
    const store = createMemoryObjectStore();
    const repository = createQueueRepository({ store, onError: () => undefined });
    await repository.save([downloadTask({ id: 'a' })]);

    store.failing.add('put');
    await repository.save([{ ...downloadTask({ id: 'a' }), bytesTotal: 1 }]);
    store.failing.delete('put');

    // The diff baseline was dropped, so the next save re-reads and writes what it must.
    await repository.save([{ ...downloadTask({ id: 'a' }), bytesTotal: 1 }]);
    expect((store.records.get('a') as { bytesTotal?: number }).bytesTotal).toBe(1);
  });
});
