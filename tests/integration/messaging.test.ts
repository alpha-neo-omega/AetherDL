import { describe, expect, it, vi } from 'vitest';
import { createMessageBus } from '@platform/messaging/service';
import { createFakeWebExt } from '../unit/platform/_fake-webext';

/**
 * Integration: two message buses sharing one runtime namespace, exercising the
 * request/response and broadcast paths end-to-end (PROJECT_BIBLE.md §8.5, §16.2).
 */
describe('platform/messaging integration', () => {
  it('round-trips a typed request/response between contexts', async () => {
    const fake = createFakeWebExt();
    const server = createMessageBus(fake.api);
    const client = createMessageBus(fake.api);

    server.on('detection/query', (request) => {
      expect(request.tabId).toBe(3);
      return [];
    });

    await expect(client.send('detection/query', { tabId: 3 })).resolves.toEqual([]);

    server.dispose();
    client.dispose();
  });

  it('delivers broadcasts to subscribers in other contexts', async () => {
    const fake = createFakeWebExt();
    const sender = createMessageBus(fake.api);
    const receiver = createMessageBus(fake.api);

    const listener = vi.fn();
    receiver.onBroadcast('tab/changed', listener);
    await sender.broadcast('tab/changed', { tabId: 7 });

    expect(listener).toHaveBeenCalledWith({ tabId: 7 });

    sender.dispose();
    receiver.dispose();
  });
});
