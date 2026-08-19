import { describe, expect, it } from 'vitest';
import { createMessageBus } from '@platform/messaging/service';
import { MessagingError, ValidationError } from '@shared/result/errors';
import { createFakeWebExt } from './_fake-webext';

describe('platform/messaging bus', () => {
  it('rejects with MessagingError when no handler responds', async () => {
    const bus = createMessageBus(createFakeWebExt().api);
    await expect(bus.send('download/enqueue', { itemIds: [] })).rejects.toBeInstanceOf(
      MessagingError,
    );
  });

  it('ignores foreign / malformed messages', async () => {
    const fake = createFakeWebExt();
    const bus = createMessageBus(fake.api);
    bus.on('download/enqueue', () => undefined);
    await expect(fake.api.runtime.sendMessage({ foo: 'bar' })).resolves.toBeUndefined();
    bus.dispose();
  });

  it('propagates a plain handler error', async () => {
    const fake = createFakeWebExt();
    const server = createMessageBus(fake.api);
    const client = createMessageBus(fake.api);
    server.on('download/enqueue', () => {
      throw new Error('boom');
    });
    await expect(client.send('download/enqueue', { itemIds: [] })).rejects.toThrow('boom');
    server.dispose();
  });

  it('preserves a PlatformError code across the boundary', async () => {
    const fake = createFakeWebExt();
    const server = createMessageBus(fake.api);
    const client = createMessageBus(fake.api);
    server.on('download/enqueue', () => {
      throw new ValidationError('bad', { code: 'x-bad', messageKey: 'k' });
    });
    await expect(client.send('download/enqueue', { itemIds: [] })).rejects.toMatchObject({
      code: 'x-bad',
    });
    server.dispose();
  });

  it('times out when a handler never responds', async () => {
    const fake = createFakeWebExt();
    const server = createMessageBus(fake.api);
    const client = createMessageBus(fake.api);
    server.on('download/enqueue', () => new Promise<void>(() => undefined));
    await expect(
      client.send('download/enqueue', { itemIds: [] }, { timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: 'messaging-timeout' });
    server.dispose();
  });

  it('dispose detaches the runtime listener', () => {
    const fake = createFakeWebExt();
    const bus = createMessageBus(fake.api);
    bus.on('download/enqueue', () => undefined);
    expect(fake.onMessage.size).toBe(1);
    bus.dispose();
    expect(fake.onMessage.size).toBe(0);
  });
});
