import { describe, expect, it } from 'vitest';
import { createStorageService } from '@platform/storage/service';
import { StorageError } from '@shared/result/errors';
import { createFakeWebExt } from './_fake-webext';

describe('platform/storage service', () => {
  it('performs typed get/set/remove/clear and batch operations', async () => {
    const storage = createStorageService(createFakeWebExt({ withSession: true }).api);
    await storage.local.set('k', { a: 1 });
    expect(await storage.local.get<{ a: number }>('k')).toEqual({ a: 1 });
    expect(await storage.local.get('missing')).toBeUndefined();

    await storage.local.setMany({ x: 1, y: 2 });
    expect(await storage.local.getMany(['x', 'y'])).toEqual({ x: 1, y: 2 });

    await storage.local.remove('x');
    expect(await storage.local.get('x')).toBeUndefined();

    await storage.local.clear();
    expect(await storage.local.get('y')).toBeUndefined();

    await storage.sync.set('s', 1);
    expect(await storage.sync.get('s')).toBe(1);
  });

  it('runs migrations in ascending order exactly once each', async () => {
    const storage = createStorageService(createFakeWebExt().api);
    const order: number[] = [];
    await storage.runMigrations('local', [
      { version: 2, migrate: async () => void order.push(2) },
      { version: 1, migrate: async () => void order.push(1) },
    ]);
    expect(order).toEqual([1, 2]);

    // Re-running with the same (and lower) versions applies nothing new.
    await storage.runMigrations('local', [
      { version: 1, migrate: async () => void order.push(1) },
      { version: 2, migrate: async () => void order.push(2) },
    ]);
    expect(order).toEqual([1, 2]);
  });

  it('rejects non-serializable values with StorageError', async () => {
    const storage = createStorageService(createFakeWebExt().api);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(storage.local.set('c', circular)).rejects.toBeInstanceOf(StorageError);
  });

  it('exposes session only when available and throws otherwise', () => {
    const withSession = createStorageService(createFakeWebExt({ withSession: true }).api);
    expect(withSession.session).toBeDefined();
    expect(withSession.area('session')).toBeDefined();

    const withoutSession = createStorageService(createFakeWebExt().api);
    expect(withoutSession.session).toBeUndefined();
    expect(withoutSession.area('local')).toBeDefined();
    expect(() => withoutSession.area('session')).toThrow(StorageError);
  });
});
