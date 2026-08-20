import { describe, expect, it, vi } from 'vitest';
import { createBrowserFrom } from '@platform/browser/factory';
import { createMessageBus } from '@platform/messaging/service';
import type { MessageBus } from '@platform/messaging';
import type { StreamDelivery, StreamDeliveryAdapter } from '@platform/stream';
import type { AppError } from '@shared/result';
import type { DownloadEventBroadcast, MediaItem } from '@shared/types';
import {
  createBackgroundDownloadRuntime,
  createDetectionItemResolver,
  DOWNLOAD_EVENT_CHANNEL,
  type BackgroundDownloadRuntime,
  type MediaItemResolver,
} from '@runtime/background/downloads';
import { createRuntimeState, type RuntimeState } from '@runtime/background/state';
import { createManualTimer, type ManualTimer } from '../../core/download/_fixtures';
import { createMemoryObjectStore, type MemoryObjectStore } from '../../core/storage/_fixtures';
import { createFakeWebExt, type FakeWebExt } from '../../platform/_fake-webext';
import { mediaItem } from '../_fixtures';

const TAB = 7;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Harness {
  readonly fake: FakeWebExt;
  readonly runtime: BackgroundDownloadRuntime;
  readonly client: MessageBus;
  readonly detection: RuntimeState;
  readonly store: MemoryObjectStore;
  readonly timer: ManualTimer;
  readonly broadcasts: DownloadEventBroadcast[];
  /** Publish detected items for the tab so `download/enqueue` can resolve them. */
  detect(items: readonly MediaItem[]): void;
  /** Drive a native download to a state and notify the runtime. */
  native(id: number, state: string, bytes?: { received: number; total: number }): Promise<void>;
}

interface SetupOptions {
  readonly store?: MemoryObjectStore;
  readonly resolver?: MediaItemResolver;
  readonly grantDownloads?: boolean;
  readonly start?: boolean;
  /** A stream-delivery adapter, or `null` to run with assembly off. */
  readonly streamDelivery?: StreamDeliveryAdapter | null;
}

function setup(options: SetupOptions = {}): Harness {
  const fake = createFakeWebExt();
  if (options.grantDownloads !== false) {
    fake.grantedPermissions.add('downloads');
  }
  const browser = createBrowserFrom(fake.api, 'chrome');
  const detection = createRuntimeState({ clock: () => 0 });
  const store = options.store ?? createMemoryObjectStore();
  const timer = createManualTimer();
  let counter = 0;
  const runtime = createBackgroundDownloadRuntime({
    browser,
    resolver: options.resolver ?? createDetectionItemResolver(detection),
    store,
    ...(options.streamDelivery !== undefined && { streamDelivery: options.streamDelivery }),
    clock: () => 1000,
    random: () => 0,
    scheduleTimer: timer.schedule,
    generateId: () => {
      counter += 1;
      return `job-${counter}`;
    },
  });
  if (options.start !== false) {
    runtime.start();
  }
  const client = createMessageBus(fake.api);
  const broadcasts: DownloadEventBroadcast[] = [];
  client.onBroadcast(DOWNLOAD_EVENT_CHANNEL, (payload) => {
    broadcasts.push(payload as DownloadEventBroadcast);
  });

  return {
    fake,
    runtime,
    client,
    detection,
    store,
    timer,
    broadcasts,
    detect(items: readonly MediaItem[]): void {
      detection.setItems(TAB, items);
    },
    async native(
      id: number,
      state: string,
      bytes?: { received: number; total: number },
    ): Promise<void> {
      const existing = fake.downloadItems.get(id);
      fake.downloadItems.set(id, {
        id,
        state,
        bytesReceived: bytes?.received ?? existing?.bytesReceived ?? 0,
        totalBytes: bytes?.total ?? existing?.totalBytes ?? 100,
        filename: existing?.filename ?? 'download',
      });
      fake.onDownloadChanged.trigger({ id, state: { current: state } });
      await flush();
    },
  };
}

/** Enqueue one downloadable item and let it reach the native layer. */
async function enqueueOne(
  harness: Harness,
  item: MediaItem = mediaItem({ id: 'a' }),
): Promise<void> {
  harness.detect([item]);
  await harness.client.send('download/enqueue', { itemIds: [item.id] });
  await flush();
}

describe('background download runtime — ownership and lifecycle', () => {
  it('holds scheduling until the durable queue is reconstructed, then resumes', async () => {
    const { runtime } = setup();
    expect(runtime.state.health().scheduling).toBe(false);
    expect(runtime.state.health().hydrated).toBe(false);

    await runtime.ready();

    expect(runtime.state.health().hydrated).toBe(true);
    expect(runtime.state.health().scheduling).toBe(true);
  });

  it('forwards the pause/resume handshake as queue lifecycle events', async () => {
    const { runtime, broadcasts } = setup({ start: false });
    const paused = vi.fn();
    const resumed = vi.fn();
    runtime.on('queue:paused', paused);
    runtime.on('queue:resumed', resumed);

    runtime.start();
    expect(paused).toHaveBeenCalledTimes(1);

    await runtime.ready();
    await flush();
    expect(resumed).toHaveBeenCalledTimes(1);
    expect(broadcasts.map((event) => event.event)).toEqual(['queue:paused', 'queue:resumed']);
  });

  it('schedules reconstructed jobs even when boot runs before start', async () => {
    const first = setup();
    await enqueueOne(first);
    await first.runtime.dispose();

    const second = setup({ store: first.store, start: false });
    await second.runtime.ready();
    await flush();

    // Event forwarding only exists after start(), but the reconstructed job must
    // still reach the browser — the boot pause/resume handshake guarantees a pump.
    expect(second.runtime.state.health().hydratedJobs).toBe(1);
    expect(second.fake.downloadItems.size).toBe(1);
  });

  it('start is idempotent', async () => {
    const harness = setup();
    harness.runtime.start();
    await harness.runtime.ready();
    await enqueueOne(harness);

    // A second registration would have queued the item twice.
    expect(harness.runtime.snapshot().stats.total).toBe(1);
  });

  it('boots once no matter how many entry points ask for it', async () => {
    const { runtime, store, fake } = setup();
    fake.onStartup.trigger();
    fake.onInstalled.trigger({ reason: 'install' });
    await runtime.ready();
    await flush();

    expect(store.calls.filter((call) => call === 'getAll:*')).toHaveLength(1);
  });

  it('browser startup reconstructs the queue without any message traffic', async () => {
    const first = setup();
    await enqueueOne(first);
    await first.runtime.dispose();

    const second = setup({ store: first.store });
    second.fake.onStartup.trigger();
    await second.runtime.ready();
    await flush();

    expect(second.runtime.state.health().hydratedJobs).toBe(1);
  });

  it('reconstructs an interrupted job and restarts its transfer on wake', async () => {
    const first = setup();
    await enqueueOne(first);
    expect(first.runtime.snapshot().stats.active).toBe(1);
    await first.runtime.dispose();

    const second = setup({ store: first.store });
    await second.runtime.ready();
    await flush();

    // The stale native handle never reaches storage.
    const record = first.store.records.get('job-1') as Record<string, unknown>;
    expect(record['nativeDownloadId']).toBeUndefined();

    const tasks = await second.client.send('download/query', undefined);
    expect(tasks).toHaveLength(1);
    // The job restarts from 'queued' against a fresh native transfer.
    expect(tasks[0]?.state).toBe('active');
    expect(tasks[0]?.nativeDownloadId).toBeDefined();
    expect(second.fake.downloadItems.size).toBe(1);
  });

  it('reports a storage failure during hydration and still starts scheduling', async () => {
    const store = createMemoryObjectStore();
    store.failing.add('getAll');
    const { runtime } = setup({ store });
    const errors: AppError[] = [];
    runtime.on('error', (error) => errors.push(error));

    await runtime.ready();

    expect(errors[0]).toMatchObject({ category: 'storage', code: 'queue-load-failed' });
    expect(runtime.state.health().scheduling).toBe(true);
    expect(runtime.state.health().hydratedJobs).toBe(0);
  });

  it('dispose detaches handlers and leaves the durable queue intact', async () => {
    const harness = setup();
    await enqueueOne(harness);
    expect(harness.store.records.size).toBe(1);

    await harness.runtime.dispose();
    await harness.runtime.dispose();

    expect(harness.store.records.size).toBe(1);
    await expect(harness.client.send('download/query', undefined)).rejects.toMatchObject({
      code: 'messaging-no-response',
    });
  });

  it('dispose stops forwarding events', async () => {
    const harness = setup();
    await enqueueOne(harness);
    const seen = vi.fn();
    harness.runtime.on('download:completed', seen);

    await harness.runtime.dispose();
    await harness.native(1, 'complete', { received: 100, total: 100 });

    expect(seen).not.toHaveBeenCalled();
  });
});

describe('background download runtime — detection to download', () => {
  it('resolves detected items by identity key and queues them', async () => {
    const harness = setup();
    const queued = vi.fn();
    harness.runtime.on('download:queued', queued);

    harness.detect([mediaItem({ id: 'a' }), mediaItem({ id: 'b', url: 'https://x.com/b.mp4' })]);
    await harness.client.send('download/enqueue', { itemIds: ['b'] });
    await flush();

    expect(queued).toHaveBeenCalledTimes(1);
    expect(harness.fake.downloadItems.size).toBe(1);
    const tasks = await harness.client.send('download/query', undefined);
    expect(tasks[0]?.item.id).toBe('b');
  });

  it('deduplicates repeated ids in one request', async () => {
    const harness = setup();
    harness.detect([mediaItem({ id: 'a' })]);
    await harness.client.send('download/enqueue', { itemIds: ['a', 'a', 'a'] });
    await flush();

    expect(harness.runtime.snapshot().stats.total).toBe(1);
  });

  it('reports unresolved ids and still queues the ones it found', async () => {
    const harness = setup();
    const errors: AppError[] = [];
    harness.runtime.on('error', (error) => errors.push(error));

    harness.detect([mediaItem({ id: 'a' })]);
    await harness.client.send('download/enqueue', { itemIds: ['a', 'ghost'] });
    await flush();

    expect(errors[0]).toMatchObject({ category: 'validation', code: 'download-unknown-items' });
    expect(harness.runtime.snapshot().stats.total).toBe(1);
  });

  it('does nothing when no id resolves', async () => {
    const harness = setup();
    await harness.client.send('download/enqueue', { itemIds: ['ghost'] });
    await flush();

    expect(harness.runtime.snapshot().stats.total).toBe(0);
    expect(harness.fake.downloadItems.size).toBe(0);
  });

  it('rejects malformed enqueue payloads without touching the queue', async () => {
    const harness = setup();
    await harness.client.send('download/enqueue', { itemIds: 'nope' } as never);
    await harness.client.send('download/enqueue', null as never);
    await harness.client.send('download/enqueue', { itemIds: [] });
    await harness.client.send('download/enqueue', { itemIds: [42, ''] } as never);
    await flush();

    expect(harness.runtime.snapshot().stats.total).toBe(0);
  });

  it('applies the existing download validation: protected media never reaches the browser', async () => {
    const harness = setup();
    const failed = vi.fn();
    harness.runtime.on('download:failed', failed);

    harness.detect([
      mediaItem({
        id: 'drm',
        url: 'https://x.com/live.m3u8',
        status: 'unsupported',
        unsupportedReason: 'protected',
      }),
    ]);
    await harness.client.send('download/enqueue', { itemIds: ['drm'] });
    await flush();

    expect(failed).toHaveBeenCalledTimes(1);
    expect(harness.fake.downloadItems.size).toBe(0);
    expect(harness.runtime.snapshot().stats.failed).toBe(1);
  });

  it('resolves an id from whichever tab detected it, in request order', () => {
    const detection = createRuntimeState({ clock: () => 0 });
    detection.setItems(1, [mediaItem({ id: 'a' })]);
    detection.setItems(2, [mediaItem({ id: 'b' }), mediaItem({ id: 'a' })]);
    const resolver = createDetectionItemResolver(detection);

    expect(resolver.resolve(['b', 'a']).map((item) => item.id)).toEqual(['b', 'a']);
    expect(resolver.resolve(['missing'])).toEqual([]);
  });
});

describe('background download runtime — permissions', () => {
  it('refuses to enqueue when the downloads permission is not granted', async () => {
    const harness = setup({ grantDownloads: false });
    const errors: AppError[] = [];
    harness.runtime.on('error', (error) => errors.push(error));

    harness.detect([mediaItem({ id: 'a' })]);
    await harness.client.send('download/enqueue', { itemIds: ['a'] });
    await flush();

    expect(errors[0]).toMatchObject({
      category: 'permission',
      code: 'download-permission-denied',
    });
    expect(harness.runtime.snapshot().stats.total).toBe(0);
    expect(harness.fake.downloadItems.size).toBe(0);
  });

  it('never requests a permission it already declares', async () => {
    const harness = setup({ grantDownloads: false });
    const request = vi.spyOn(harness.fake.api.permissions, 'request');

    harness.detect([mediaItem({ id: 'a' })]);
    await harness.client.send('download/enqueue', { itemIds: ['a'] });
    await flush();

    expect(request).not.toHaveBeenCalled();
  });

  it('reports a failing permission query but lets the download proceed', async () => {
    const harness = setup();
    const errors: AppError[] = [];
    harness.runtime.on('error', (error) => errors.push(error));
    harness.fake.api.permissions.contains = (): Promise<boolean> =>
      Promise.reject(new Error('permissions unavailable'));

    await enqueueOne(harness);

    expect(errors[0]).toMatchObject({ category: 'permission' });
    expect(harness.runtime.snapshot().stats.active).toBe(1);
  });
});

describe('background download runtime — message handlers', () => {
  it('download/query returns the whole queue', async () => {
    const harness = setup();
    await enqueueOne(harness);

    const tasks = await harness.client.send('download/query', undefined);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe('job-1');
  });

  it('download/stats returns counts by lifecycle state', async () => {
    const harness = setup();
    await enqueueOne(harness);

    const stats = await harness.client.send('download/stats', undefined);
    expect(stats.total).toBe(1);
    expect(stats.active).toBe(1);
    expect(stats.completed).toBe(0);
  });

  it('download/progress reports only jobs still in flight', async () => {
    const harness = setup();
    await enqueueOne(harness);
    await harness.native(1, 'in_progress', { received: 40, total: 100 });

    const inFlight = await harness.client.send('download/progress', undefined);
    expect(inFlight).toEqual([
      {
        taskId: 'job-1',
        state: 'active',
        filename: 'Video.mp4',
        bytesReceived: 40,
        bytesTotal: 100,
        progress: 0.4,
      },
    ]);

    await harness.native(1, 'complete', { received: 100, total: 100 });
    expect(await harness.client.send('download/progress', undefined)).toEqual([]);
  });

  it('download/cancel stops the transfer promptly and idempotently', async () => {
    const harness = setup();
    await enqueueOne(harness);

    await harness.client.send('download/cancel', { taskId: 'job-1' });
    await harness.client.send('download/cancel', { taskId: 'job-1' });
    await flush();

    expect(harness.runtime.snapshot().stats.canceled).toBe(1);
    expect(harness.runtime.state.health().canceled).toBe(1);
    expect(harness.fake.downloadItems.get(1)?.state).toBe('interrupted');
  });

  it('download/pause parks a job and download/resume restarts it', async () => {
    const harness = setup();
    await enqueueOne(harness);

    await harness.client.send('download/pause', { taskId: 'job-1' });
    await flush();
    expect(harness.runtime.snapshot().stats.paused).toBe(1);

    await harness.client.send('download/resume', { taskId: 'job-1' });
    await flush();
    expect(harness.runtime.snapshot().stats.active).toBe(1);
  });

  it('download/remove drops a job from the queue and from durable storage', async () => {
    const harness = setup();
    await enqueueOne(harness);

    await harness.client.send('download/remove', { taskId: 'job-1' });
    await flush();

    expect(harness.runtime.snapshot().stats.total).toBe(0);
    expect(harness.store.records.size).toBe(0);
  });

  it('download/clear removes settled jobs but keeps a live transfer', async () => {
    const harness = setup();
    harness.detect([mediaItem({ id: 'a' }), mediaItem({ id: 'b', url: 'https://x.com/b.mp4' })]);
    await harness.client.send('download/enqueue', { itemIds: ['a'] });
    await flush();
    await harness.native(1, 'complete', { received: 100, total: 100 });
    await harness.client.send('download/enqueue', { itemIds: ['b'] });
    await flush();

    await harness.client.send('download/clear', undefined);
    await flush();

    const tasks = await harness.client.send('download/query', undefined);
    expect(tasks.map((task) => task.id)).toEqual(['job-2']);
  });

  it('ignores single-job commands with a malformed payload', async () => {
    const harness = setup();
    await enqueueOne(harness);

    await harness.client.send('download/cancel', { taskId: '' } as never);
    await harness.client.send('download/pause', null as never);
    await harness.client.send('download/remove', { taskId: 7 } as never);
    await flush();

    expect(harness.runtime.snapshot().stats.active).toBe(1);
  });

  it('ignores commands for an unknown job', async () => {
    const harness = setup();
    await harness.runtime.ready();

    await expect(
      harness.client.send('download/cancel', { taskId: 'ghost' }),
    ).resolves.toBeUndefined();
    expect(harness.runtime.snapshot().stats.total).toBe(0);
  });

  it('reports and propagates a handler failure', async () => {
    const harness = setup({
      resolver: {
        resolve: () => {
          throw new Error('resolver exploded');
        },
      },
    });
    const errors: AppError[] = [];
    harness.runtime.on('error', (error) => errors.push(error));

    await expect(harness.client.send('download/enqueue', { itemIds: ['a'] })).rejects.toMatchObject(
      { code: 'download-operation-failed' },
    );
    expect(errors[0]).toMatchObject({ category: 'internal', code: 'download-operation-failed' });
  });

  it('returns outstanding operations to zero once handlers settle', async () => {
    const harness = setup();
    await enqueueOne(harness);
    await harness.client.send('download/stats', undefined);

    expect(harness.runtime.state.outstandingCount()).toBe(0);
  });
});

describe('background download runtime — event forwarding', () => {
  it('forwards the full lifecycle of a successful download', async () => {
    const harness = setup();
    const seen: string[] = [];
    for (const event of [
      'download:queued',
      'download:preparing',
      'download:started',
      'download:progress',
      'download:completed',
    ] as const) {
      harness.runtime.on(event, () => seen.push(event));
    }

    await enqueueOne(harness);
    await harness.native(1, 'in_progress', { received: 50, total: 100 });
    await harness.native(1, 'complete', { received: 100, total: 100 });

    expect(seen).toEqual([
      'download:queued',
      'download:preparing',
      'download:started',
      'download:progress',
      'download:completed',
    ]);
    expect(harness.runtime.state.health()).toMatchObject({
      enqueued: 1,
      started: 1,
      completed: 1,
    });
  });

  it('broadcasts a compact snapshot for each job event', async () => {
    const harness = setup();
    await enqueueOne(harness);
    await harness.native(1, 'complete', { received: 100, total: 100 });

    const completed = harness.broadcasts.find((event) => event.event === 'download:completed');
    expect(completed?.task).toEqual({
      taskId: 'job-1',
      state: 'completed',
      filename: 'Video.mp4',
      bytesReceived: 100,
      bytesTotal: 100,
      progress: 1,
    });
  });

  it('announces queue completion when the last job settles', async () => {
    const harness = setup();
    const completed = vi.fn();
    harness.runtime.on('queue:completed', completed);

    await enqueueOne(harness);
    await harness.native(1, 'complete', { received: 100, total: 100 });

    expect(completed).toHaveBeenCalledWith({ completed: 1, failed: 0, canceled: 0 });
    expect(harness.broadcasts.at(-1)).toEqual({
      event: 'queue:completed',
      summary: { completed: 1, failed: 0, canceled: 0 },
    });
  });

  it('forwards a scheduled retry and clears it when the job restarts', async () => {
    const harness = setup();
    const scheduled = vi.fn();
    harness.runtime.on('retry:scheduled', scheduled);

    await enqueueOne(harness);
    await harness.native(1, 'interrupted');

    expect(scheduled).toHaveBeenCalledTimes(1);
    expect(harness.runtime.snapshot().retries).toEqual([
      { taskId: 'job-1', attempt: 0, delayMs: 500, scheduledAt: 1000 },
    ]);
    const broadcast = harness.broadcasts.find((event) => event.event === 'retry:scheduled');
    expect(broadcast?.retry).toEqual({ taskId: 'job-1', attempt: 0, delayMs: 500 });

    harness.timer.fireAll();
    await flush();

    expect(harness.runtime.snapshot().retries).toEqual([]);
    expect(harness.runtime.snapshot().stats.active).toBe(1);
  });

  it('fails a job for good once retries are exhausted, then allows a manual retry', async () => {
    const harness = setup();
    const failed = vi.fn();
    harness.runtime.on('download:failed', failed);
    await enqueueOne(harness);

    // maxRetries defaults to 3, so the fourth interruption is terminal (§10.4).
    for (let nativeId = 1; nativeId <= 4; nativeId += 1) {
      await harness.native(nativeId, 'interrupted');
      harness.timer.fireAll();
      await flush();
    }

    expect(failed).toHaveBeenCalledTimes(1);
    expect(harness.runtime.snapshot().stats.failed).toBe(1);
    expect(harness.runtime.state.health().retriesScheduled).toBe(3);

    await harness.client.send('download/retry', { taskId: 'job-1' });
    await flush();

    const tasks = await harness.client.send('download/query', undefined);
    expect(tasks[0]?.state).toBe('active');
    expect(tasks[0]?.attempt).toBe(0);
  });

  it('forwards a cancellation', async () => {
    const harness = setup();
    const cancelled = vi.fn();
    harness.runtime.on('download:cancelled', cancelled);

    await enqueueOne(harness);
    await harness.client.send('download/cancel', { taskId: 'job-1' });
    await flush();

    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(harness.broadcasts.some((event) => event.event === 'download:cancelled')).toBe(true);
  });

  it('forwards manager errors and strips diagnostics from the broadcast', async () => {
    const harness = setup();
    const errors: AppError[] = [];
    harness.runtime.on('error', (error) => errors.push(error));

    harness.detect([mediaItem({ id: 'blob', url: 'blob:https://x.com/abc', delivery: 'blob' })]);
    await harness.client.send('download/enqueue', { itemIds: ['blob'] });
    await flush();

    expect(errors[0]).toMatchObject({ category: 'validation' });
    expect(errors[0]?.context).toBeDefined();
    const broadcast = harness.broadcasts.find((event) => event.event === 'error');
    expect(broadcast?.error).toEqual({
      category: 'validation',
      code: 'download-forbidden-delivery',
      messageKey: 'error.download.validation',
      retryable: false,
    });
    expect(harness.runtime.state.health().errors).toBeGreaterThan(0);
  });

  it('exposes queue statistics, health and retries in one snapshot', async () => {
    const harness = setup();
    await enqueueOne(harness);

    const snapshot = harness.runtime.snapshot();
    expect(snapshot.stats.active).toBe(1);
    expect(snapshot.health.hydrated).toBe(true);
    expect(snapshot.retries).toEqual([]);
  });
});

describe('background download runtime — host access for stream downloads (§13.7)', () => {
  /** An adapter that records what it was asked to assemble. */
  function streamAdapter(): { adapter: StreamDeliveryAdapter; requested: string[] } {
    const requested: string[] = [];
    return {
      requested,
      adapter: {
        supported: true,
        handles: (url) => url.endsWith('.m3u8') || url.endsWith('.mpd'),
        assemble: (request): Promise<StreamDelivery> => {
          requested.push(request.manifestUrl);
          return Promise.resolve({
            url: 'blob:aetherdl/1',
            byteLength: 8,
            extension: 'ts',
            mimeType: 'video/mp2t',
            segmentCount: 1,
            origins: ['https://cdn.test/*'],
            release: () => Promise.resolve(),
          });
        },
      },
    };
  }

  const stream = (url = 'https://cdn.test/hls/master.m3u8'): MediaItem =>
    mediaItem({ id: url, url, kind: 'stream', delivery: 'hls' });

  it('asks for the stream host before enqueueing, whatever started the download', async () => {
    // This is the context-menu path: nothing has asked for a permission yet.
    const delivery = streamAdapter();
    const h = setup({ streamDelivery: delivery.adapter });
    h.detect([stream()]);

    await h.runtime.enqueue([stream().id]);
    await flush();

    expect([...h.fake.grantedOrigins]).toEqual(['https://cdn.test/*']);
    const queue = await h.client.send('download/query', undefined);
    expect(queue).toHaveLength(1);
  });

  it('does not ask again once the host is already granted', async () => {
    const delivery = streamAdapter();
    const h = setup({ streamDelivery: delivery.adapter });
    h.fake.grantedOrigins.add('https://cdn.test/*');
    h.fake.denyPermissions = true; // any request would now be refused
    h.detect([stream()]);

    await h.runtime.enqueue([stream().id]);
    await flush();

    const queue = await h.client.send('download/query', undefined);
    expect(queue).toHaveLength(1);
  });

  it('reports a declined host and queues nothing for it', async () => {
    const delivery = streamAdapter();
    const h = setup({ streamDelivery: delivery.adapter });
    const errors: AppError[] = [];
    h.runtime.on('error', (error) => {
      errors.push(error);
    });
    h.fake.denyPermissions = true;
    h.detect([stream()]);

    await h.runtime.enqueue([stream().id]);
    await flush();

    const queue = await h.client.send('download/query', undefined);
    expect(queue).toEqual([]);
    expect(delivery.requested).toEqual([]);
    // The user is told which permission is missing, not left with a network error.
    expect(errors.some((error) => error.code === 'download-stream-host-denied')).toBe(true);
    expect(errors.some((error) => error.messageKey === 'error.permission.host')).toBe(true);
  });

  it('keeps the rest of a batch when one stream host is declined', async () => {
    const delivery = streamAdapter();
    const h = setup({ streamDelivery: delivery.adapter });
    h.fake.denyPermissions = true;
    const progressive = mediaItem({ id: 'clip', url: 'https://files.test/clip.mp4' });
    h.detect([stream(), progressive]);

    await h.runtime.enqueue([stream().id, 'clip']);
    await flush();

    const queue = (await h.client.send('download/query', undefined)) as readonly {
      item: { id: string };
    }[];
    expect(queue.map((task) => task.item.id)).toEqual(['clip']);
  });

  it('drops an assembly document a previous worker generation left open', async () => {
    // The service worker restarts; the offscreen document does not. Whatever it was
    // holding is untracked from here on, so boot lets it go (§8.9, §12.1).
    const delivery = streamAdapter();
    const reset = vi.fn(() => Promise.resolve());
    const h = setup({ streamDelivery: { ...delivery.adapter, reset } });

    await h.runtime.ready();

    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('boots even when dropping that document fails', async () => {
    const delivery = streamAdapter();
    const h = setup({
      streamDelivery: {
        ...delivery.adapter,
        reset: () => Promise.reject(new Error('no such document')),
      },
    });

    await expect(h.runtime.ready()).resolves.toBeUndefined();
    const queue = await h.client.send('download/query', undefined);
    expect(queue).toEqual([]);
  });

  it('asks for nothing at all when no stream is involved', async () => {
    const delivery = streamAdapter();
    const h = setup({ streamDelivery: delivery.adapter });
    h.detect([mediaItem({ id: 'clip', url: 'https://files.test/clip.mp4' })]);

    await h.runtime.enqueue(['clip']);
    await flush();

    expect([...h.fake.grantedOrigins]).toEqual([]);
  });
});
