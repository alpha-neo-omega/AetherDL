/**
 * The Chromium offscreen delivery client (PROJECT_BIBLE.md §10.6, §7.4). Only small
 * messages cross this boundary: a manifest URL out, a local URL back. The document's
 * lifetime is the contract worth proving — it must be open while bytes are held and
 * closed once they are released, or a stream-sized blob stays resident (§12.1).
 */
import { describe, expect, it, vi } from 'vitest';
import type { WebExtApi } from '@platform/browser/webext';
import type { MessageBus } from '@platform/messaging';
import { MessagingError } from '@shared/result/errors';
import {
  createOffscreenStreamDelivery,
  OFFSCREEN_DOCUMENT_PATH,
  STREAM_PROGRESS_BROADCAST,
} from '@platform/stream/offscreen';

const RESULT = {
  url: 'blob:chrome-extension://aetherdl/1',
  byteLength: 2048,
  extension: 'ts',
  mimeType: 'video/mp2t',
  segmentCount: 3,
  origins: ['https://cdn.test/*'],
};

interface Harness {
  readonly api: WebExtApi;
  readonly messaging: MessageBus;
  readonly sent: { type: string; payload: unknown }[];
  readonly offscreen: { created: number; closed: number };
  emitProgress(payload: unknown): void;
  failAssemble(error: unknown): void;
  onCreate(behaviour: () => Promise<void>): void;
  /** Runs when the client sends `stream/assemble`, i.e. while assembly is live. */
  onAssemble(behaviour: () => void): void;
  /** Simulate a document whose script never starts listening. */
  setHostReady(ready: boolean): void;
}

function harness(options: { hasOffscreen?: boolean } = {}): Harness {
  const sent: { type: string; payload: unknown }[] = [];
  const offscreen = { created: 0, closed: 0 };
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let assembleError: unknown;
  let createBehaviour: (() => Promise<void>) | undefined;
  let assembleBehaviour: (() => void) | undefined;
  let hostReady = true;

  const api = {
    ...(options.hasOffscreen === false
      ? {}
      : {
          offscreen: {
            createDocument: async (parameters: { url: string }): Promise<void> => {
              expect(parameters.url).toBe(OFFSCREEN_DOCUMENT_PATH);
              offscreen.created += 1;
              if (createBehaviour !== undefined) {
                await createBehaviour();
              }
            },
            closeDocument: (): Promise<void> => {
              offscreen.closed += 1;
              return Promise.resolve();
            },
          },
        }),
  } as unknown as WebExtApi;

  const messaging = {
    send: (type: string, payload: unknown): Promise<unknown> => {
      // The readiness probe is answered by the host, not recorded as work: the client
      // polls it before sending anything real (see `stream/ready`).
      if (type === 'stream/ready') {
        return hostReady
          ? Promise.resolve(true)
          : Promise.reject(new Error('Could not establish connection'));
      }
      sent.push({ type, payload });
      if (type === 'stream/assemble') {
        assembleBehaviour?.();
        return assembleError === undefined
          ? Promise.resolve(RESULT)
          : Promise.reject(assembleError as Error);
      }
      return Promise.resolve(undefined);
    },
    onBroadcast: (type: string, listener: (payload: unknown) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
      return () => {
        set.delete(listener);
      };
    },
  } as unknown as MessageBus;

  return {
    api,
    messaging,
    sent,
    offscreen,
    emitProgress(payload: unknown): void {
      for (const listener of listeners.get(STREAM_PROGRESS_BROADCAST) ?? []) {
        listener(payload);
      }
    },
    failAssemble(error: unknown): void {
      assembleError = error;
    },
    onCreate(behaviour: () => Promise<void>): void {
      createBehaviour = behaviour;
    },
    onAssemble(behaviour: () => void): void {
      assembleBehaviour = behaviour;
    },
    setHostReady(ready: boolean): void {
      hostReady = ready;
    },
  };
}

describe('offscreen stream delivery', () => {
  it('opens the document, assembles, and reports what came back', async () => {
    const h = harness();
    const delivery = createOffscreenStreamDelivery({
      api: h.api,
      messaging: h.messaging,
      generateId: () => 'req-fixed',
    });

    const result = await delivery.assemble({ manifestUrl: 'https://cdn.test/a.m3u8' });

    expect(delivery.supported).toBe(true);
    expect(h.offscreen.created).toBe(1);
    expect(h.sent[0]).toEqual({
      type: 'stream/assemble',
      payload: { manifestUrl: 'https://cdn.test/a.m3u8', requestId: 'req-fixed' },
    });
    expect(result).toMatchObject(RESULT);
    // Bytes are still held, so the document must stay open.
    expect(h.offscreen.closed).toBe(0);
  });

  it('closes the document when the delivery is released', async () => {
    const h = harness();
    const delivery = createOffscreenStreamDelivery({ api: h.api, messaging: h.messaging });

    const result = await delivery.assemble({ manifestUrl: 'https://cdn.test/a.m3u8' });
    await result.release();

    expect(h.sent.map((message) => message.type)).toEqual(['stream/assemble', 'stream/release']);
    expect(h.sent[1]?.payload).toEqual({ url: RESULT.url });
    expect(h.offscreen.closed).toBe(1);
  });

  it('releases at most once', async () => {
    const h = harness();
    const delivery = createOffscreenStreamDelivery({ api: h.api, messaging: h.messaging });

    const result = await delivery.assemble({ manifestUrl: 'https://cdn.test/a.m3u8' });
    await result.release();
    await result.release();

    expect(h.sent.filter((message) => message.type === 'stream/release')).toHaveLength(1);
  });

  it('relays only the progress belonging to this request', async () => {
    const h = harness();
    const onProgress = vi.fn();
    const delivery = createOffscreenStreamDelivery({
      api: h.api,
      messaging: h.messaging,
      generateId: () => 'req-a',
    });
    h.onAssemble(() => {
      // Another job, same manifest URL: keyed by id, this must not be relayed.
      h.emitProgress({
        manifestUrl: 'https://cdn.test/a.m3u8',
        requestId: 'req-b',
        segmentsDone: 7,
        segmentsTotal: 9,
        bytesReceived: 77,
      });
      h.emitProgress({
        manifestUrl: 'https://other.test/b.m3u8',
        segmentsDone: 9,
        segmentsTotal: 9,
        bytesReceived: 99,
      });
      h.emitProgress({
        manifestUrl: 'https://cdn.test/a.m3u8',
        segmentsDone: 1,
        segmentsTotal: 3,
        bytesReceived: 512,
      });
      h.emitProgress({ manifestUrl: 'https://cdn.test/a.m3u8', segmentsDone: 'nonsense' });
    });

    await delivery.assemble({ manifestUrl: 'https://cdn.test/a.m3u8', onProgress });

    expect(onProgress.mock.calls).toEqual([
      [{ segmentsDone: 1, segmentsTotal: 3, bytesReceived: 512 }],
    ]);
  });

  it('tells the host to abort exactly this request', async () => {
    const h = harness();
    const controller = new AbortController();
    const delivery = createOffscreenStreamDelivery({
      api: h.api,
      messaging: h.messaging,
      generateId: () => 'req-abort',
    });
    h.onAssemble(() => {
      controller.abort();
    });

    await delivery.assemble({ manifestUrl: 'https://cdn.test/a.m3u8', signal: controller.signal });

    const abort = h.sent.find((message) => message.type === 'stream/abort');
    expect(abort?.payload).toEqual({
      manifestUrl: 'https://cdn.test/a.m3u8',
      requestId: 'req-abort',
    });
  });

  it('closes a document a previous worker generation left behind', async () => {
    const h = harness();
    const delivery = createOffscreenStreamDelivery({ api: h.api, messaging: h.messaging });

    await delivery.reset?.();

    // Nothing is tracked after a restart, so the stale document — and the blob it
    // holds — is dropped rather than left resident.
    expect(h.offscreen.closed).toBe(1);
  });

  it('does not reset while a delivery of this session still holds bytes', async () => {
    const h = harness();
    const delivery = createOffscreenStreamDelivery({ api: h.api, messaging: h.messaging });

    await delivery.assemble({ manifestUrl: 'https://cdn.test/a.m3u8' });
    await delivery.reset?.();

    expect(h.offscreen.closed).toBe(0);
  });

  it('closes the document again when assembly failed, holding nothing', async () => {
    const h = harness();
    h.failAssemble(new Error('refused'));
    const delivery = createOffscreenStreamDelivery({ api: h.api, messaging: h.messaging });

    await expect(delivery.assemble({ manifestUrl: 'https://cdn.test/a.m3u8' })).rejects.toThrow(
      /refused/,
    );
    expect(h.offscreen.closed).toBe(1);
  });

  it('treats "only a single offscreen document" as the race it is', async () => {
    const h = harness();
    h.onCreate(() => Promise.reject(new Error('Only a single offscreen document may be created')));
    const delivery = createOffscreenStreamDelivery({ api: h.api, messaging: h.messaging });

    await expect(
      delivery.assemble({ manifestUrl: 'https://cdn.test/a.m3u8' }),
    ).resolves.toMatchObject({ url: RESULT.url });
  });

  it('reports a document that never starts listening, without sending work into it', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.setHostReady(false);
      const delivery = createOffscreenStreamDelivery({ api: h.api, messaging: h.messaging });

      const pending = delivery.assemble({ manifestUrl: 'https://cdn.test/a.m3u8' });
      const assertion = expect(pending).rejects.toMatchObject({
        code: 'stream-offscreen-not-ready',
      });
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;

      expect(h.sent).toEqual([]);
      // A document that cannot serve is not left open.
      expect(h.offscreen.closed).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a real document-open failure rather than assembling blind', async () => {
    const h = harness();
    h.onCreate(() => Promise.reject(new Error('quota exceeded')));
    const delivery = createOffscreenStreamDelivery({ api: h.api, messaging: h.messaging });

    await expect(
      delivery.assemble({ manifestUrl: 'https://cdn.test/a.m3u8' }),
    ).rejects.toMatchObject({ code: 'stream-offscreen-open-failed' });
    expect(h.sent).toEqual([]);
  });

  it('restores the host refusal, so an encrypted stream is not reported as a network fault', async () => {
    const h = harness();
    // What the bus hands back: the code survives, the meaning does not.
    h.failAssemble(
      new MessagingError('Playlist is encrypted (METHOD=AES-128)', {
        code: 'stream-hls-encrypted',
        messageKey: 'error.messaging.handler',
      }),
    );
    const delivery = createOffscreenStreamDelivery({ api: h.api, messaging: h.messaging });

    await expect(
      delivery.assemble({ manifestUrl: 'https://cdn.test/a.m3u8' }),
    ).rejects.toMatchObject({
      category: 'drm',
      code: 'stream-hls-encrypted',
      messageKey: 'error.drm',
      retryable: false,
    });
  });

  it('restores a transport failure as retryable', async () => {
    const h = harness();
    h.failAssemble(
      new MessagingError('Segment 2 of 9 failed (http-network-failed)', {
        code: 'stream-segment-failed',
        messageKey: 'error.messaging.handler',
      }),
    );
    const delivery = createOffscreenStreamDelivery({ api: h.api, messaging: h.messaging });

    await expect(
      delivery.assemble({ manifestUrl: 'https://cdn.test/a.m3u8' }),
    ).rejects.toMatchObject({ category: 'network', messageKey: 'error.network', retryable: true });
  });

  it('leaves an error that is not a stream refusal exactly as it was', async () => {
    const h = harness();
    const original = new MessagingError('No valid response', {
      code: 'messaging-no-response',
      messageKey: 'error.messaging.noResponse',
    });
    h.failAssemble(original);
    const delivery = createOffscreenStreamDelivery({ api: h.api, messaging: h.messaging });

    await expect(delivery.assemble({ manifestUrl: 'https://cdn.test/a.m3u8' })).rejects.toBe(
      original,
    );
  });

  it('is unsupported where the engine has no offscreen API at all', async () => {
    const h = harness({ hasOffscreen: false });
    const delivery = createOffscreenStreamDelivery({ api: h.api, messaging: h.messaging });

    expect(delivery.supported).toBe(false);
    await expect(
      delivery.assemble({ manifestUrl: 'https://cdn.test/a.m3u8' }),
    ).rejects.toMatchObject({ code: 'stream-offscreen-unavailable' });
  });

  it('recognises manifests, and nothing else', () => {
    const h = harness();
    const delivery = createOffscreenStreamDelivery({ api: h.api, messaging: h.messaging });

    expect(delivery.handles('https://cdn.test/a.m3u8')).toBe(true);
    expect(delivery.handles('https://cdn.test/a.mpd')).toBe(true);
    expect(delivery.handles('https://cdn.test/a.mp4')).toBe(false);
  });
});
