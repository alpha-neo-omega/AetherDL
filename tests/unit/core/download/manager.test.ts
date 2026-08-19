import { describe, expect, it, vi } from 'vitest';
import type { DownloadManager } from '@core/download/manager';
import { createDownloadSystem } from '@core/download/factory';
import {
  createFakeDownloads,
  createManualTimer,
  mediaItem,
  tick,
  type FakeDownloads,
  type ManualTimer,
} from './_fixtures';

interface Harness {
  readonly manager: DownloadManager;
  readonly fake: FakeDownloads;
  readonly timer: ManualTimer;
}

function makeSystem(overrides: { maxConcurrent?: number; maxRetries?: number } = {}): Harness {
  const fake = createFakeDownloads();
  const timer = createManualTimer();
  let counter = 0;
  const manager = createDownloadSystem({
    downloads: fake.adapter,
    clock: () => 1000,
    random: () => 0,
    scheduleTimer: timer.schedule,
    generateId: () => {
      counter += 1;
      return `job-${counter}`;
    },
    maxConcurrent: overrides.maxConcurrent ?? 2,
    maxRetries: overrides.maxRetries ?? 2,
    baseDelayMs: 500,
  });
  return { manager, fake, timer };
}

describe('download manager', () => {
  it('validates on enqueue: valid media starts, forbidden media fails without a native start', async () => {
    const { manager, fake } = makeSystem();
    const queuedSpy = vi.fn();
    const failedSpy = vi.fn();
    manager.on('job:queued', queuedSpy);
    manager.on('job:failed', failedSpy);

    const created = await manager.enqueue([
      mediaItem({ url: 'https://x.com/a.mp4', delivery: 'html5' }),
      mediaItem({ url: 'https://x.com/live.m3u8', delivery: 'hls', kind: 'stream' }),
    ]);
    await tick();

    expect(queuedSpy).toHaveBeenCalledTimes(1);
    expect(failedSpy).toHaveBeenCalledTimes(1);
    const good = manager.getTask(created[0]!.id);
    const bad = manager.getTask(created[1]!.id);
    expect(good?.state).toBe('active');
    expect(bad?.state).toBe('failed');
    // Only the valid item reached the native layer.
    expect(fake.started).toHaveLength(1);
    expect(fake.started[0]?.url).toBe('https://x.com/a.mp4');
  });

  it('respects the concurrency limit', async () => {
    const { manager, fake } = makeSystem({ maxConcurrent: 2 });
    await manager.enqueue([
      mediaItem({ url: 'https://x.com/1.mp4' }),
      mediaItem({ url: 'https://x.com/2.mp4' }),
      mediaItem({ url: 'https://x.com/3.mp4' }),
    ]);
    await tick();
    const stats = manager.stats();
    expect(stats.active).toBe(2);
    expect(stats.queued).toBe(1);
    expect(fake.started).toHaveLength(2);
  });

  it('completes a job, records history, and starts the next queued job', async () => {
    const history = {
      record: vi.fn().mockResolvedValue(undefined),
      list: vi.fn(),
      delete: vi.fn(),
      clear: vi.fn(),
    };
    const fake = createFakeDownloads();
    const manager = createDownloadSystem({
      downloads: fake.adapter,
      clock: () => 1000,
      maxConcurrent: 1,
      history,
      generateId: (() => {
        let n = 0;
        return () => `job-${(n += 1)}`;
      })(),
    });
    const completedSpy = vi.fn();
    manager.on('job:completed', completedSpy);

    const [first, second] = await manager.enqueue([
      mediaItem({ url: 'https://x.com/1.mp4' }),
      mediaItem({ url: 'https://x.com/2.mp4' }),
    ]);
    await tick();
    expect(manager.getTask(first!.id)?.state).toBe('active');
    expect(manager.getTask(second!.id)?.state).toBe('queued');

    const nativeId = manager.getTask(first!.id)!.nativeDownloadId!;
    fake.setItem(nativeId, { state: 'completed', bytesReceived: 100 });
    fake.emit({ id: nativeId, state: 'completed' });
    await tick();

    expect(manager.getTask(first!.id)?.state).toBe('completed');
    expect(completedSpy).toHaveBeenCalledTimes(1);
    expect(history.record).toHaveBeenCalledTimes(1);
    // Freed slot pulls the next job.
    expect(manager.getTask(second!.id)?.state).toBe('active');
    await manager.dispose();
  });

  it('updates progress from adapter change events', async () => {
    const { manager, fake } = makeSystem({ maxConcurrent: 1 });
    const progressSpy = vi.fn();
    manager.on('progress', progressSpy);
    const [job] = await manager.enqueue([mediaItem({ url: 'https://x.com/a.mp4' })]);
    await tick();
    const nativeId = manager.getTask(job!.id)!.nativeDownloadId!;
    fake.setItem(nativeId, { state: 'active', bytesReceived: 40, bytesTotal: 100 });
    fake.emit({ id: nativeId, state: 'active' });
    await tick();
    const task = manager.getTask(job!.id);
    expect(task?.bytesReceived).toBe(40);
    expect(task?.progress).toBeCloseTo(0.4);
    expect(progressSpy).toHaveBeenCalled();
  });

  it('retries a retryable failure with backoff, then succeeds on restart', async () => {
    const { manager, fake, timer } = makeSystem({ maxConcurrent: 1, maxRetries: 2 });
    const retrySpy = vi.fn();
    manager.on('retry:scheduled', retrySpy);
    const [job] = await manager.enqueue([mediaItem({ url: 'https://x.com/a.mp4' })]);
    await tick();
    const nativeId = manager.getTask(job!.id)!.nativeDownloadId!;

    fake.setItem(nativeId, { state: 'failed' });
    fake.emit({ id: nativeId, state: 'failed' });
    await tick();

    expect(manager.getTask(job!.id)?.state).toBe('retrying');
    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(timer.pending).toBe(1);

    timer.fireAll();
    await tick();
    expect(manager.getTask(job!.id)?.state).toBe('active');
    expect(fake.started).toHaveLength(2);
  });

  it('fails permanently when retries are exhausted', async () => {
    const { manager, fake } = makeSystem({ maxConcurrent: 1, maxRetries: 0 });
    const failedSpy = vi.fn();
    manager.on('job:failed', failedSpy);
    const [job] = await manager.enqueue([mediaItem({ url: 'https://x.com/a.mp4' })]);
    await tick();
    const nativeId = manager.getTask(job!.id)!.nativeDownloadId!;
    fake.setItem(nativeId, { state: 'failed' });
    fake.emit({ id: nativeId, state: 'failed' });
    await tick();
    expect(manager.getTask(job!.id)?.state).toBe('failed');
    expect(failedSpy).toHaveBeenCalledTimes(1);
  });

  it('cancels an active job through the adapter', async () => {
    const { manager, fake } = makeSystem({ maxConcurrent: 1 });
    const cancelledSpy = vi.fn();
    manager.on('job:cancelled', cancelledSpy);
    const [job] = await manager.enqueue([mediaItem({ url: 'https://x.com/a.mp4' })]);
    await tick();
    const nativeId = manager.getTask(job!.id)!.nativeDownloadId!;
    await manager.cancel(job!.id);
    expect(fake.canceled).toContain(nativeId);
    expect(manager.getTask(job!.id)?.state).toBe('canceled');
    expect(cancelledSpy).toHaveBeenCalledTimes(1);
  });

  it('pauses a queued job and resumes it', async () => {
    const { manager } = makeSystem({ maxConcurrent: 1 });
    const [active, queued] = await manager.enqueue([
      mediaItem({ url: 'https://x.com/1.mp4' }),
      mediaItem({ url: 'https://x.com/2.mp4' }),
    ]);
    await tick();
    await manager.pause(queued!.id);
    expect(manager.getTask(queued!.id)?.state).toBe('paused');
    await manager.resume(queued!.id);
    expect(manager.getTask(queued!.id)?.state).toBe('queued');
    expect(active).toBeDefined();
  });

  it('pauseQueue holds scheduling; resumeQueue releases it', async () => {
    const { manager, fake } = makeSystem({ maxConcurrent: 2 });
    const pausedSpy = vi.fn();
    const resumedSpy = vi.fn();
    manager.on('queue:paused', pausedSpy);
    manager.on('queue:resumed', resumedSpy);
    manager.pauseQueue();
    await manager.enqueue([mediaItem({ url: 'https://x.com/a.mp4' })]);
    await tick();
    expect(fake.started).toHaveLength(0);
    expect(pausedSpy).toHaveBeenCalledTimes(1);
    manager.resumeQueue();
    await tick();
    expect(fake.started).toHaveLength(1);
    expect(resumedSpy).toHaveBeenCalledTimes(1);
  });

  it('removes a job and clears non-active jobs', async () => {
    const { manager } = makeSystem({ maxConcurrent: 1 });
    const [a, b] = await manager.enqueue([
      mediaItem({ url: 'https://x.com/1.mp4' }),
      mediaItem({ url: 'https://x.com/2.mp4' }),
    ]);
    await tick();
    await manager.remove(b!.id);
    expect(manager.getTask(b!.id)).toBeUndefined();
    // The active job remains; clearQueue leaves it.
    await manager.clearQueue();
    expect(manager.getTask(a!.id)?.state).toBe('active');
  });

  it('dispose detaches the adapter listener and clears retry timers', async () => {
    const { manager, fake } = makeSystem();
    await manager.enqueue([mediaItem({ url: 'https://x.com/a.mp4' })]);
    await tick();
    await manager.dispose();
    // After dispose the manager no longer reacts to native changes.
    const before = manager.stats();
    fake.emit({ id: 1, state: 'completed' });
    await tick();
    expect(manager.stats()).toEqual(before);
  });

  it('cancels a queued (non-active) job without touching the adapter', async () => {
    const { manager, fake } = makeSystem({ maxConcurrent: 1 });
    const [, queued] = await manager.enqueue([
      mediaItem({ url: 'https://x.com/1.mp4' }),
      mediaItem({ url: 'https://x.com/2.mp4' }),
    ]);
    await tick();
    await manager.cancel(queued!.id);
    expect(manager.getTask(queued!.id)?.state).toBe('canceled');
    expect(fake.canceled).toHaveLength(0);
  });

  it('pauses an active job (cancel + hold) and restarts it on resume', async () => {
    const { manager, fake } = makeSystem({ maxConcurrent: 1 });
    const [job] = await manager.enqueue([mediaItem({ url: 'https://x.com/a.mp4' })]);
    await tick();
    const nativeId = manager.getTask(job!.id)!.nativeDownloadId!;
    await manager.pause(job!.id);
    expect(fake.canceled).toContain(nativeId);
    expect(manager.getTask(job!.id)?.state).toBe('paused');
    await manager.resume(job!.id);
    await tick();
    expect(manager.getTask(job!.id)?.state).toBe('active');
    expect(fake.started).toHaveLength(2);
  });

  it('supports manual retry of a permanently failed job', async () => {
    const { manager, fake } = makeSystem({ maxConcurrent: 1, maxRetries: 0 });
    const [job] = await manager.enqueue([mediaItem({ url: 'https://x.com/a.mp4' })]);
    await tick();
    const nativeId = manager.getTask(job!.id)!.nativeDownloadId!;
    fake.setItem(nativeId, { state: 'failed' });
    fake.emit({ id: nativeId, state: 'failed' });
    await tick();
    expect(manager.getTask(job!.id)?.state).toBe('failed');
    await manager.retry(job!.id);
    await tick();
    expect(manager.getTask(job!.id)?.state).toBe('active');
  });

  it('retries when the native start throws', async () => {
    const { manager, fake, timer } = makeSystem({ maxConcurrent: 1, maxRetries: 1 });
    fake.failNextStart = true;
    const [job] = await manager.enqueue([mediaItem({ url: 'https://x.com/a.mp4' })]);
    await tick();
    expect(manager.getTask(job!.id)?.state).toBe('retrying');
    timer.fireAll();
    await tick();
    expect(manager.getTask(job!.id)?.state).toBe('active');
    expect(fake.started).toHaveLength(2);
  });

  it('stopQueue cancels all non-terminal jobs and pauses scheduling', async () => {
    const { manager } = makeSystem({ maxConcurrent: 1 });
    const [a, b] = await manager.enqueue([
      mediaItem({ url: 'https://x.com/1.mp4' }),
      mediaItem({ url: 'https://x.com/2.mp4' }),
    ]);
    await tick();
    await manager.stopQueue();
    expect(manager.getTask(a!.id)?.state).toBe('canceled');
    expect(manager.getTask(b!.id)?.state).toBe('canceled');
  });

  it('removes an active job by cancelling it first', async () => {
    const { manager, fake } = makeSystem({ maxConcurrent: 1 });
    const [job] = await manager.enqueue([mediaItem({ url: 'https://x.com/a.mp4' })]);
    await tick();
    const nativeId = manager.getTask(job!.id)!.nativeDownloadId!;
    await manager.remove(job!.id);
    expect(fake.canceled).toContain(nativeId);
    expect(manager.getTask(job!.id)).toBeUndefined();
  });

  it('cancels a job caught in the preparing window without throwing, then stops the late native start', async () => {
    const { manager, fake } = makeSystem({ maxConcurrent: 1 });
    fake.holdStart();
    const [job] = await manager.enqueue([mediaItem({ url: 'https://x.com/a.mp4' })]);
    await tick();
    expect(manager.getTask(job!.id)?.state).toBe('preparing');
    // Must not reject with an illegal-transition QueueError (preparing→canceled).
    await expect(manager.cancel(job!.id)).resolves.toBeUndefined();
    expect(manager.getTask(job!.id)?.state).toBe('canceled');
    // When the held start finally resolves, startJob cancels the orphaned native id.
    fake.releaseStart();
    await tick();
    expect(manager.getTask(job!.id)?.state).toBe('canceled');
    expect(fake.canceled.length).toBeGreaterThanOrEqual(1);
  });

  it('manual retry() refuses a validation-failed (DRM/unsupported) job', async () => {
    const { manager, fake } = makeSystem({ maxConcurrent: 1 });
    const [job] = await manager.enqueue([
      mediaItem({ url: 'https://x.com/drm.mp4', status: 'unsupported', unsupportedReason: 'DRM' }),
    ]);
    await tick();
    expect(manager.getTask(job!.id)?.state).toBe('failed');
    await manager.retry(job!.id);
    await tick();
    // Not resurrected; no native start ever issued for forbidden media.
    expect(manager.getTask(job!.id)?.state).toBe('failed');
    expect(fake.started).toHaveLength(0);
  });

  it('does not self-collide: a lone download keeps its original filename', async () => {
    const { manager } = makeSystem({ maxConcurrent: 1 });
    const [job] = await manager.enqueue([
      mediaItem({ url: 'https://x.com/clip.mp4', title: 'clip', extension: 'mp4' }),
    ]);
    await tick();
    const task = manager.getTask(job!.id);
    expect(task?.filename).toBe(task?.originalFilename);
    expect(task?.filename).not.toMatch(/\(\d+\)/);
  });

  it('notifies subscribers of queue state changes', async () => {
    const { manager } = makeSystem();
    const listener = vi.fn();
    manager.subscribe(listener);
    await manager.enqueue([mediaItem({ url: 'https://x.com/a.mp4' })]);
    await tick();
    expect(listener).toHaveBeenCalled();
    const lastCall = listener.mock.calls.at(-1)?.[0] as { tasks: unknown[] };
    expect(lastCall.tasks.length).toBeGreaterThan(0);
  });

  it('stops notifying after unsubscribe', async () => {
    const { manager } = makeSystem({ maxConcurrent: 1 });
    const listener = vi.fn();
    const unsubscribe = manager.subscribe(listener);
    await manager.enqueue([mediaItem({ url: 'https://x.com/a.mp4' })]);
    const before = listener.mock.calls.length;
    unsubscribe();
    await manager.enqueue([mediaItem({ url: 'https://x.com/b.mp4' })]);
    expect(listener.mock.calls.length).toBe(before);
  });

  it('emits error when the native progress query fails', async () => {
    const { manager, fake } = makeSystem({ maxConcurrent: 1 });
    const errorSpy = vi.fn();
    manager.on('error', errorSpy);
    const [job] = await manager.enqueue([mediaItem({ url: 'https://x.com/a.mp4' })]);
    await tick();
    const nativeId = manager.getTask(job!.id)!.nativeDownloadId!;
    fake.failProgress = true;
    fake.emit({ id: nativeId, state: 'active' });
    await tick();
    expect(errorSpy).toHaveBeenCalled();
    expect(manager.getTask(job!.id)?.state).toBe('active');
  });

  it('dispose cancels pending retry timers', async () => {
    const { manager, fake, timer } = makeSystem({ maxConcurrent: 1, maxRetries: 2 });
    fake.failNextStart = true;
    const [job] = await manager.enqueue([mediaItem({ url: 'https://x.com/a.mp4' })]);
    await tick();
    expect(manager.getTask(job!.id)?.state).toBe('retrying');
    expect(timer.pending).toBe(1);
    await manager.dispose();
    expect(timer.pending).toBe(0);
    timer.fireAll();
    await tick();
    expect(manager.getTask(job!.id)?.state).toBe('retrying');
  });
});
