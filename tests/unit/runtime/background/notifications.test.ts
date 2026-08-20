import { describe, expect, it, vi } from 'vitest';
import { createBrowserFrom } from '@platform/browser/factory';
import { DEFAULT_SETTINGS } from '@core/settings';
import type { QueueStats } from '@core/download/queue';
import type { AppError } from '@shared/result';
import type { DownloadTask, Settings } from '@shared/types';
import { TypedEventEmitter } from '@shared/utils';
import { createNotificationRuntime } from '@runtime/background/notifications';
import type {
  BackgroundDownloadRuntime,
  DownloadRuntimeEventMap,
} from '@runtime/background/downloads';
import { createFakeWebExt, type FakeWebExtOptions } from '../../platform/_fake-webext';
import { mediaItem } from '../_fixtures';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const EMPTY_STATS: QueueStats = {
  total: 0,
  queued: 0,
  preparing: 0,
  active: 0,
  paused: 0,
  retrying: 0,
  canceling: 0,
  completed: 0,
  failed: 0,
  canceled: 0,
  removed: 0,
};

function task(id: string, filename = `${id}.mp4`): DownloadTask {
  return {
    id,
    item: mediaItem({ id }),
    state: 'completed',
    filename,
    attempt: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

interface Options {
  readonly settings?: Partial<Settings>;
  readonly granted?: boolean;
  readonly fake?: FakeWebExtOptions;
  readonly stats?: Partial<QueueStats>;
}

function setup(options: Options = {}) {
  const fake = createFakeWebExt(options.fake ?? { notifications: true });
  if (options.granted !== false) {
    fake.grantedPermissions.add('notifications');
  }
  const browser = createBrowserFrom(fake.api, 'chrome');
  const emitter = new TypedEventEmitter<DownloadRuntimeEventMap>();
  let stats: QueueStats = { ...EMPTY_STATS, ...options.stats };
  const errors: AppError[] = [];
  let settings: Settings = { ...DEFAULT_SETTINGS, ...options.settings };

  const downloads = {
    on: <K extends keyof DownloadRuntimeEventMap>(
      event: K,
      listener: (...args: DownloadRuntimeEventMap[K]) => void,
    ) => emitter.on(event, listener),
    snapshot: () => ({ stats, health: {}, retries: [] }),
  } as unknown as BackgroundDownloadRuntime;

  const runtime = createNotificationRuntime({
    browser,
    downloads,
    getSettings: () => Promise.resolve(settings),
    copy: {
      completed: (job) => ({ title: 'Download complete', message: job.filename }),
      failed: (job) => ({ title: 'Download failed', message: job.filename }),
      queueCompleted: (summary) => ({
        title: 'Downloads finished',
        message: `${summary.completed}/${summary.failed}/${summary.canceled}`,
      }),
    },
    onError: (error) => errors.push(error),
    iconUrl: 'icons/icon-48.png',
  });
  runtime.start();

  return {
    fake,
    runtime,
    emitter,
    errors,
    setStats: (next: Partial<QueueStats>) => {
      stats = { ...EMPTY_STATS, ...next };
    },
    setSettings: (next: Partial<Settings>) => {
      settings = { ...settings, ...next };
    },
  };
}

describe('background notification runtime', () => {
  it('announces a completed download with the packaged icon', async () => {
    const harness = setup();
    harness.emitter.emit('download:completed', task('job-1', 'Clip.mp4'));
    await flush();

    expect([...harness.fake.notifications.values()]).toEqual([
      {
        type: 'basic',
        title: 'Download complete',
        message: 'Clip.mp4',
        iconUrl: 'icons/icon-48.png',
      },
    ]);
  });

  it('announces a download that failed for good', async () => {
    const harness = setup();
    harness.emitter.emit('download:failed', task('job-1', 'Broken.mp4'));
    await flush();
    expect([...harness.fake.notifications.values()][0]?.title).toBe('Download failed');
  });

  it('stays silent while the user has notifications turned off', async () => {
    const harness = setup({ settings: { notifications: false } });
    harness.emitter.emit('download:completed', task('job-1'));
    await flush();
    expect(harness.fake.notifications.size).toBe(0);
  });

  it('stays silent while the optional permission is not granted, and never requests it', async () => {
    const harness = setup({ granted: false });
    const request = vi.spyOn(harness.fake.api.permissions, 'request');

    harness.emitter.emit('download:completed', task('job-1'));
    await flush();

    expect(harness.fake.notifications.size).toBe(0);
    expect(request).not.toHaveBeenCalled();
  });

  it('stays silent when the browser exposes no notifications namespace', async () => {
    const harness = setup({ fake: {} });
    harness.emitter.emit('download:completed', task('job-1'));
    await flush();
    expect(harness.fake.notifications.size).toBe(0);
    expect(harness.errors).toEqual([]);
  });

  it('follows a setting change without a restart', async () => {
    const harness = setup({ settings: { notifications: false } });
    harness.emitter.emit('download:completed', task('job-1'));
    await flush();
    expect(harness.fake.notifications.size).toBe(0);

    harness.setSettings({ notifications: true });
    harness.emitter.emit('download:completed', task('job-2'));
    await flush();
    expect(harness.fake.notifications.size).toBe(1);
  });

  it('coalesces a bulk run into one summary instead of a toast per job', async () => {
    const harness = setup({ stats: { active: 1, queued: 3 } });
    harness.emitter.emit('download:completed', task('job-1'));
    harness.emitter.emit('download:completed', task('job-2'));
    await flush();
    expect(harness.fake.notifications.size).toBe(0);

    harness.setStats({});
    harness.emitter.emit('queue:completed', { completed: 4, failed: 1, canceled: 0 });
    await flush();

    expect([...harness.fake.notifications.values()]).toEqual([
      expect.objectContaining({ title: 'Downloads finished', message: '4/1/0' }),
    ]);
  });

  it('announces a single job even when one transfer is in flight', async () => {
    const harness = setup({ stats: { active: 1 } });
    harness.emitter.emit('download:completed', task('job-1'));
    await flush();
    expect(harness.fake.notifications.size).toBe(1);
  });

  it('reports a notification the browser refuses', async () => {
    const harness = setup();
    harness.fake.failNotifications = true;
    harness.emitter.emit('download:completed', task('job-1'));
    await flush();
    expect(harness.errors[0]).toMatchObject({ code: 'notifications-create-failed' });
  });

  it('reports a settings read that fails and stays silent', async () => {
    const fake = createFakeWebExt({ notifications: true });
    fake.grantedPermissions.add('notifications');
    const emitter = new TypedEventEmitter<DownloadRuntimeEventMap>();
    const errors: AppError[] = [];
    const runtime = createNotificationRuntime({
      browser: createBrowserFrom(fake.api, 'chrome'),
      downloads: {
        on: <K extends keyof DownloadRuntimeEventMap>(
          event: K,
          listener: (...args: DownloadRuntimeEventMap[K]) => void,
        ) => emitter.on(event, listener),
        snapshot: () => ({ stats: EMPTY_STATS, health: {}, retries: [] }),
      } as unknown as BackgroundDownloadRuntime,
      getSettings: () => Promise.reject(new Error('storage down')),
      copy: {
        completed: () => ({ title: 't', message: 'm' }),
        failed: () => ({ title: 't', message: 'm' }),
        queueCompleted: () => ({ title: 't', message: 'm' }),
      },
      onError: (error) => errors.push(error),
    });
    runtime.start();

    emitter.emit('download:completed', task('job-1'));
    await flush();

    expect(errors[0]).toBeDefined();
    expect(fake.notifications.size).toBe(0);
  });

  it('omits the icon when none is configured', async () => {
    const fake = createFakeWebExt({ notifications: true });
    fake.grantedPermissions.add('notifications');
    const emitter = new TypedEventEmitter<DownloadRuntimeEventMap>();
    const runtime = createNotificationRuntime({
      browser: createBrowserFrom(fake.api, 'chrome'),
      downloads: {
        on: <K extends keyof DownloadRuntimeEventMap>(
          event: K,
          listener: (...args: DownloadRuntimeEventMap[K]) => void,
        ) => emitter.on(event, listener),
        snapshot: () => ({ stats: EMPTY_STATS, health: {}, retries: [] }),
      } as unknown as BackgroundDownloadRuntime,
      getSettings: () => Promise.resolve(DEFAULT_SETTINGS),
      copy: {
        completed: () => ({ title: 'Done', message: 'x' }),
        failed: () => ({ title: 'Failed', message: 'x' }),
        queueCompleted: () => ({ title: 'Batch', message: 'x' }),
      },
      onError: () => undefined,
    });
    runtime.start();

    emitter.emit('download:completed', task('job-1'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect([...fake.notifications.values()][0]).toEqual({
      type: 'basic',
      title: 'Done',
      message: 'x',
    });
  });

  it('start is idempotent and dispose stops every announcement', async () => {
    const harness = setup();
    harness.runtime.start();

    harness.runtime.dispose();
    harness.runtime.dispose();
    harness.emitter.emit('download:completed', task('job-1'));
    await flush();

    expect(harness.fake.notifications.size).toBe(0);
  });
});

describe('notifications: a bulk run is announced once (§4.10)', () => {
  it('announces only the summary, even as the batch drains', async () => {
    // Regression: a batch drains, so by the time the last jobs finished only one —
    // then none — was in flight, and each produced its own toast on top of the
    // summary. A three-job batch announced twice and then summarised.
    const harness = setup({ stats: { active: 1, queued: 2 } });

    harness.setStats({ active: 1, queued: 1 });
    harness.emitter.emit('download:completed', task('job-1'));
    await flush();
    harness.setStats({ active: 1 });
    harness.emitter.emit('download:completed', task('job-2'));
    await flush();
    harness.setStats({});
    harness.emitter.emit('download:completed', task('job-3'));
    harness.emitter.emit('queue:completed', { completed: 3, failed: 0, canceled: 0 });
    await flush();

    expect([...harness.fake.notifications.values()].map((entry) => entry.title)).toEqual([
      'Downloads finished',
    ]);
  });

  it('announces a lone download once, and does not also summarise it', async () => {
    const harness = setup({ stats: { active: 1 } });

    harness.emitter.emit('download:completed', task('job-1'));
    harness.setStats({});
    harness.emitter.emit('queue:completed', { completed: 1, failed: 0, canceled: 0 });
    await flush();

    // One download, one notification — not the job and then "downloads finished".
    expect([...harness.fake.notifications.values()].map((entry) => entry.title)).toEqual([
      'Download complete',
    ]);
  });

  it('goes back to per-job announcements after a bulk run ends', async () => {
    const harness = setup({ stats: { active: 2 } });

    harness.emitter.emit('download:completed', task('job-1'));
    harness.setStats({});
    harness.emitter.emit('queue:completed', { completed: 2, failed: 0, canceled: 0 });
    await flush();
    harness.emitter.emit('download:completed', task('later-job'));
    await flush();

    expect([...harness.fake.notifications.values()].map((entry) => entry.title)).toEqual([
      'Downloads finished',
      'Download complete',
    ]);
  });

  it('treats work queued behind a running job as a bulk run', async () => {
    const harness = setup({ stats: { active: 1 } });

    // A second job arrives while the first is still running.
    harness.setStats({ active: 1, queued: 1 });
    harness.emitter.emit('download:queued', task('job-2'));
    harness.setStats({ active: 1 });
    harness.emitter.emit('download:completed', task('job-1'));
    await flush();

    expect(harness.fake.notifications.size).toBe(0);
  });
});
