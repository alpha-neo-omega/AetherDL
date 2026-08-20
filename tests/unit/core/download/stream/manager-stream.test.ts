/**
 * Stream jobs inside the download manager (PROJECT_BIBLE.md §10.6, §10.2, §10.7).
 *
 * The invariants: a manifest is assembled first and the browser is handed the
 * assembled local file (never the playlist); the saved name carries the real
 * container; the bytes are freed on EVERY exit path; and a build without assembly
 * still refuses streams outright.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  StreamDelivery,
  StreamDeliveryAdapter,
  StreamDeliveryRequest,
} from '@platform/stream';
import { StreamAssemblyError } from '@core/download/errors';
import { createDownloadSystem } from '@core/download/factory';
import type { DownloadManager } from '@core/download/manager';
import { createFakeDownloads, mediaItem, tick, type FakeDownloads } from '../_fixtures';

const MANIFEST = 'https://cdn.test/hls/master.m3u8';

function streamItem(url = MANIFEST): ReturnType<typeof mediaItem> {
  return mediaItem({
    url,
    id: url,
    kind: 'stream',
    delivery: 'hls',
    container: undefined,
    extension: undefined,
    title: 'Sample Stream',
  });
}

interface FakeDelivery {
  readonly adapter: StreamDeliveryAdapter;
  /** Manifest URLs assembly was asked for, in order. */
  readonly requested: string[];
  readonly released: string[];
  /** Requests still in flight, so a test can settle or observe them. */
  readonly pending: {
    request: StreamDeliveryRequest;
    resolve: (delivery: StreamDelivery) => void;
    reject: (error: unknown) => void;
  }[];
  settle(overrides?: Partial<StreamDelivery>): void;
}

function fakeDelivery(options: { supported?: boolean; auto?: boolean } = {}): FakeDelivery {
  const requested: string[] = [];
  const released: string[] = [];
  const pending: FakeDelivery['pending'] = [];
  let counter = 0;

  const build = (overrides: Partial<StreamDelivery> = {}): StreamDelivery => {
    counter += 1;
    const url = `blob:aetherdl/${String(counter)}`;
    return {
      url,
      byteLength: 4096,
      extension: 'ts',
      mimeType: 'video/mp2t',
      segmentCount: 2,
      origins: ['https://cdn.test/*'],
      release: (): Promise<void> => {
        released.push(overrides.url ?? url);
        return Promise.resolve();
      },
      ...overrides,
    };
  };

  const fake: FakeDelivery = {
    requested,
    released,
    pending,
    settle(overrides?: Partial<StreamDelivery>): void {
      const next = pending.shift();
      next?.resolve(build(overrides));
    },
    adapter: {
      supported: options.supported ?? true,
      handles: (url: string) => url.endsWith('.m3u8') || url.endsWith('.mpd'),
      assemble: (request: StreamDeliveryRequest): Promise<StreamDelivery> => {
        requested.push(request.manifestUrl);
        if (options.auto !== false) {
          return Promise.resolve(build());
        }
        return new Promise<StreamDelivery>((resolve, reject) => {
          pending.push({ request, resolve, reject });
        });
      },
    },
  };
  return fake;
}

function makeSystem(delivery?: StreamDeliveryAdapter): {
  readonly manager: DownloadManager;
  readonly fake: FakeDownloads;
} {
  const fake = createFakeDownloads();
  let counter = 0;
  const manager = createDownloadSystem({
    downloads: fake.adapter,
    clock: () => 1000,
    random: () => 0,
    generateId: () => {
      counter += 1;
      return `job-${counter}`;
    },
    maxConcurrent: 2,
    maxRetries: 1,
    ...(delivery !== undefined && { streamDelivery: delivery }),
  });
  return { manager, fake };
}

describe('a stream job with assembly available', () => {
  it('assembles the manifest and hands the browser the assembled file', async () => {
    const delivery = fakeDelivery();
    const { manager, fake } = makeSystem(delivery.adapter);

    const [task] = await manager.enqueue([streamItem()]);
    await tick();

    expect(delivery.requested).toEqual([MANIFEST]);
    expect(fake.started).toHaveLength(1);
    // The playlist URL is NEVER what gets saved.
    expect(fake.started[0]?.url).toBe('blob:aetherdl/1');
    expect(fake.started[0]?.url).not.toBe(MANIFEST);
    expect(manager.getTask(task!.id)?.state).toBe('active');
  });

  it('saves under the container the assembly actually produced, not the playlist extension', async () => {
    const delivery = fakeDelivery();
    const { manager, fake } = makeSystem(delivery.adapter);

    await manager.enqueue([streamItem()]);
    await tick();

    expect(fake.started[0]?.filename.endsWith('.ts')).toBe(true);
    expect(fake.started[0]?.filename).not.toContain('.m3u8');
  });

  it('takes the assembled size as the job total', async () => {
    const delivery = fakeDelivery();
    const { manager } = makeSystem(delivery.adapter);

    const [task] = await manager.enqueue([streamItem()]);
    await tick();

    expect(manager.getTask(task!.id)?.bytesTotal).toBe(4096);
  });

  it('reports assembly progress on the job while it is still preparing', async () => {
    const delivery = fakeDelivery({ auto: false });
    const { manager } = makeSystem(delivery.adapter);
    const progressSpy = vi.fn();
    manager.on('progress', progressSpy);

    const [task] = await manager.enqueue([streamItem()]);
    await tick();
    expect(manager.getTask(task!.id)?.state).toBe('preparing');

    delivery.pending[0]?.request.onProgress?.({
      segmentsDone: 1,
      segmentsTotal: 4,
      bytesReceived: 1024,
    });
    await tick();

    const snapshot = manager.getTask(task!.id);
    expect(snapshot?.bytesReceived).toBe(1024);
    expect(snapshot?.progress).toBeCloseTo(0.25);
    expect(progressSpy).toHaveBeenCalled();
  });

  it('frees the assembled bytes once the save completes', async () => {
    const delivery = fakeDelivery();
    const { manager, fake } = makeSystem(delivery.adapter);

    await manager.enqueue([streamItem()]);
    await tick();
    fake.setItem(1, { state: 'completed', bytesReceived: 4096, bytesTotal: 4096 });
    fake.emit({ id: 1, state: 'completed' });
    await tick();

    expect(delivery.released).toEqual(['blob:aetherdl/1']);
  });

  it('stops the assembly and frees nothing held when the user cancels mid-assembly', async () => {
    const delivery = fakeDelivery({ auto: false });
    const { manager, fake } = makeSystem(delivery.adapter);

    const [task] = await manager.enqueue([streamItem()]);
    await tick();
    await manager.cancel(task!.id);
    await tick();

    expect(delivery.pending[0]?.request.signal?.aborted).toBe(true);
    expect(manager.getTask(task!.id)?.state).toBe('canceled');
    // No transfer was ever started for a job the user cancelled while assembling.
    expect(fake.started).toEqual([]);
  });

  it('frees the bytes when the assembly finishes after a cancel', async () => {
    const delivery = fakeDelivery({ auto: false });
    const { manager, fake } = makeSystem(delivery.adapter);

    const [task] = await manager.enqueue([streamItem()]);
    await tick();
    await manager.cancel(task!.id);
    delivery.settle();
    await tick();

    expect(delivery.released).toEqual(['blob:aetherdl/1']);
    expect(fake.started).toEqual([]);
  });

  it('fails the job with the assembler’s own reason when a manifest is refused', async () => {
    const delivery = fakeDelivery({ auto: false });
    const { manager, fake } = makeSystem(delivery.adapter);
    const failedSpy = vi.fn();
    manager.on('job:failed', failedSpy);

    const [task] = await manager.enqueue([streamItem()]);
    await tick();
    // Exactly what the assembler throws for an encrypted playlist.
    delivery.pending[0]?.reject(
      new StreamAssemblyError('Playlist is encrypted (METHOD=AES-128)', {
        code: 'stream-hls-encrypted',
        messageKey: 'error.download.stream',
      }),
    );
    await tick();

    const failed = manager.getTask(task!.id);
    expect(failed?.state).toBe('failed');
    expect(failed?.error?.code).toBe('stream-hls-encrypted');
    // A refusal is not retried, and nothing was handed to the browser.
    expect(failedSpy).toHaveBeenCalledTimes(1);
    expect(fake.started).toEqual([]);
  });

  it('leaves a progressive download completely untouched by the stream path', async () => {
    const delivery = fakeDelivery();
    const { manager, fake } = makeSystem(delivery.adapter);

    await manager.enqueue([mediaItem({ url: 'https://cdn.test/clip.mp4' })]);
    await tick();

    expect(delivery.requested).toEqual([]);
    expect(fake.started[0]?.url).toBe('https://cdn.test/clip.mp4');
  });
});

describe('pausing a stream job (§10.2)', () => {
  it('parks the job and stops the fetches instead of failing it', async () => {
    const delivery = fakeDelivery({ auto: false });
    const { manager, fake } = makeSystem(delivery.adapter);

    const [task] = await manager.enqueue([streamItem()]);
    await tick();
    expect(manager.getTask(task!.id)?.state).toBe('preparing');

    await manager.pause(task!.id);
    await tick();

    // The user asked to pause, so the job is paused — not failed, not stuck.
    expect(manager.getTask(task!.id)?.state).toBe('paused');
    expect(delivery.pending[0]?.request.signal?.aborted).toBe(true);
    expect(fake.started).toEqual([]);
  });

  it('assembles again from the beginning when resumed', async () => {
    const delivery = fakeDelivery({ auto: false });
    const { manager, fake } = makeSystem(delivery.adapter);

    const [task] = await manager.enqueue([streamItem()]);
    await tick();
    await manager.pause(task!.id);
    await tick();
    await manager.resume(task!.id);
    await tick();

    expect(manager.getTask(task!.id)?.state).toBe('preparing');
    expect(delivery.requested).toEqual([MANIFEST, MANIFEST]);

    delivery.settle();
    await tick();
    expect(fake.started).toHaveLength(1);
  });

  it('frees the slot it held, so another job can start', async () => {
    const delivery = fakeDelivery({ auto: false });
    const { manager, fake } = makeSystem(delivery.adapter);

    const [stream] = await manager.enqueue([streamItem()]);
    await tick();
    await manager.pause(stream!.id);
    await tick();

    await manager.enqueue([mediaItem({ url: 'https://cdn.test/clip.mp4', id: 'clip' })]);
    await tick();

    expect(fake.started).toHaveLength(1);
    expect(fake.started[0]?.url).toBe('https://cdn.test/clip.mp4');
  });
});

describe('assembly is serialized (§12.1)', () => {
  it('runs one assembly at a time, however many stream jobs are queued', async () => {
    const delivery = fakeDelivery({ auto: false });
    const { manager } = makeSystem(delivery.adapter);

    await manager.enqueue([
      streamItem('https://cdn.test/a.m3u8'),
      streamItem('https://cdn.test/b.m3u8'),
    ]);
    await tick();

    // Both jobs may hold a download slot, but only one is allowed to hold a stream
    // in memory: 2 × the ceiling at once is how a worker dies.
    expect(delivery.requested).toEqual(['https://cdn.test/a.m3u8']);

    delivery.settle();
    await tick();
    await tick();

    expect(delivery.requested).toEqual(['https://cdn.test/a.m3u8', 'https://cdn.test/b.m3u8']);
  });
});

describe('progress patches while assembling', () => {
  it('writes at most once per interval, and always on the last segment', async () => {
    const delivery = fakeDelivery({ auto: false });
    const fake = createFakeDownloads();
    let now = 1000;
    let counter = 0;
    const manager = createDownloadSystem({
      downloads: fake.adapter,
      clock: () => now,
      generateId: () => {
        counter += 1;
        return `job-${String(counter)}`;
      },
      streamDelivery: delivery.adapter,
    });
    const progressSpy = vi.fn();
    manager.on('progress', progressSpy);

    const [task] = await manager.enqueue([streamItem()]);
    await tick();
    const report = delivery.pending[0]?.request.onProgress;

    // Four segments land inside the same 500 ms window; only the first and the final
    // one are worth a queue write.
    report?.({ segmentsDone: 1, segmentsTotal: 4, bytesReceived: 100 });
    await tick();
    now += 10;
    report?.({ segmentsDone: 2, segmentsTotal: 4, bytesReceived: 200 });
    await tick();
    now += 10;
    report?.({ segmentsDone: 3, segmentsTotal: 4, bytesReceived: 300 });
    await tick();
    now += 10;
    report?.({ segmentsDone: 4, segmentsTotal: 4, bytesReceived: 400 });
    await tick();

    expect(progressSpy).toHaveBeenCalledTimes(2);
    // The visible state still ends correct: the final report is never dropped.
    expect(manager.getTask(task!.id)?.bytesReceived).toBe(400);
    expect(manager.getTask(task!.id)?.progress).toBe(1);
  });

  it('writes again once the interval has passed', async () => {
    const delivery = fakeDelivery({ auto: false });
    const fake = createFakeDownloads();
    let now = 1000;
    let counter = 0;
    const manager = createDownloadSystem({
      downloads: fake.adapter,
      clock: () => now,
      generateId: () => {
        counter += 1;
        return `job-${String(counter)}`;
      },
      streamDelivery: delivery.adapter,
    });
    const progressSpy = vi.fn();
    manager.on('progress', progressSpy);

    await manager.enqueue([streamItem()]);
    await tick();
    const report = delivery.pending[0]?.request.onProgress;

    report?.({ segmentsDone: 1, segmentsTotal: 100, bytesReceived: 10 });
    await tick();
    now += 600;
    report?.({ segmentsDone: 2, segmentsTotal: 100, bytesReceived: 20 });
    await tick();

    expect(progressSpy).toHaveBeenCalledTimes(2);
  });
});

describe('a stream job without assembly', () => {
  it('is refused at enqueue, exactly as before, with no native start', async () => {
    const { manager, fake } = makeSystem();
    const failedSpy = vi.fn();
    manager.on('job:failed', failedSpy);

    const [task] = await manager.enqueue([streamItem()]);
    await tick();

    const failed = manager.getTask(task!.id);
    expect(failed?.state).toBe('failed');
    expect(failed?.error?.code).toBe('download-manifest-url');
    expect(fake.started).toEqual([]);
    expect(failedSpy).toHaveBeenCalledTimes(1);
  });

  it('is refused when the adapter exists but reports itself unsupported', async () => {
    const delivery = fakeDelivery({ supported: false });
    const { manager, fake } = makeSystem(delivery.adapter);

    const [task] = await manager.enqueue([streamItem()]);
    await tick();

    expect(manager.getTask(task!.id)?.state).toBe('failed');
    expect(delivery.requested).toEqual([]);
    expect(fake.started).toEqual([]);
  });
});
