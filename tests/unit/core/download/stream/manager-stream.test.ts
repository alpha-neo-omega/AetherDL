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
