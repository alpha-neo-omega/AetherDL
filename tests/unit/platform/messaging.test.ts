import { describe, expect, it, vi } from 'vitest';
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

describe('platform/messaging: one responder per type (§8.5)', () => {
  it('refuses a second handler for the same type instead of replacing it silently', () => {
    // Regression: the second registration replaced the first without a word, so a
    // wiring mistake left a handler that would never be called again and no sign of it.
    const fake = createFakeWebExt();
    const bus = createMessageBus(fake.api);
    bus.on('download/query', () => Promise.resolve([]));

    expect(() => bus.on('download/query', () => Promise.resolve([]))).toThrow(/already registered/);
  });

  it('allows re-registration once the first handler is detached', () => {
    const fake = createFakeWebExt();
    const bus = createMessageBus(fake.api);
    const off = bus.on('download/query', () => Promise.resolve([]));
    off();

    expect(() => bus.on('download/query', () => Promise.resolve([]))).not.toThrow();
  });

  it('allows re-registration after dispose', () => {
    const fake = createFakeWebExt();
    const bus = createMessageBus(fake.api);
    bus.on('download/query', () => Promise.resolve([]));
    bus.dispose();

    expect(() => bus.on('download/query', () => Promise.resolve([]))).not.toThrow();
  });

  it('keeps delivering a broadcast when one subscriber throws', async () => {
    const fake = createFakeWebExt();
    const bus = createMessageBus(fake.api);
    const later = vi.fn();
    bus.onBroadcast('probe', () => {
      throw new Error('subscriber blew up');
    });
    bus.onBroadcast('probe', later);

    await createMessageBus(fake.api).broadcast('probe', { ok: true });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(later).toHaveBeenCalledWith({ ok: true });
  });
});
