import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@core/settings';
import { createSettingsService } from '@core/settings/settings';
import { createSettingsRepository, SETTINGS_STORAGE_KEY } from '@core/storage/settings-repository';
import type { SettingsRepository } from '@core/storage';
import type { AppError } from '@shared/result';
import type { Settings } from '@shared/types';

interface FakeRepository extends SettingsRepository {
  stored: Settings | undefined;
  failLoad: boolean;
  failSave: boolean;
  readonly saves: number;
}

function createFakeRepository(): FakeRepository {
  let saves = 0;
  const repository: FakeRepository = {
    stored: undefined,
    failLoad: false,
    failSave: false,
    get saves(): number {
      return saves;
    },
    load(): Promise<Settings | undefined> {
      return repository.failLoad
        ? Promise.reject(new Error('storage unavailable'))
        : Promise.resolve(repository.stored);
    },
    save(settings: Settings): Promise<void> {
      saves += 1;
      if (repository.failSave) {
        return Promise.reject(new Error('quota exceeded'));
      }
      repository.stored = settings;
      return Promise.resolve();
    },
  };
  return repository;
}

function setup(): {
  readonly repository: FakeRepository;
  readonly errors: AppError[];
  readonly service: ReturnType<typeof createSettingsService>;
} {
  const repository = createFakeRepository();
  const errors: AppError[] = [];
  const service = createSettingsService({
    repository,
    onError: (error) => errors.push(error),
  });
  return { repository, errors, service };
}

describe('core/settings service', () => {
  it('answers with the normative defaults on a fresh install', async () => {
    const { service } = setup();
    expect(await service.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('repairs a stored catalogue instead of trusting it', async () => {
    const { repository, service } = setup();
    repository.stored = { theme: 'dark', maxRetries: 900 } as unknown as Settings;
    expect(await service.get()).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark' });
  });

  it('reads storage once and serves the catalogue from memory afterwards', async () => {
    const { repository, service } = setup();
    const load = vi.spyOn(repository, 'load');
    await Promise.all([service.get(), service.get()]);
    await service.get();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('applies a validated change and persists it', async () => {
    const { repository, service } = setup();
    const applied = await service.update({ theme: 'dark', maxRetries: 5 });
    expect(applied).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark', maxRetries: 5 });
    expect(repository.stored).toEqual(applied);
    expect(await service.get()).toEqual(applied);
  });

  it('merges a change onto the current catalogue rather than replacing it', async () => {
    const { service } = setup();
    await service.update({ theme: 'dark' });
    const applied = await service.update({ maxRetries: 1 });
    expect(applied.theme).toBe('dark');
    expect(applied.maxRetries).toBe(1);
  });

  it('rejects an invalid change and writes nothing', async () => {
    const { repository, service } = setup();
    await service.update({ theme: 'dark' });
    const before = repository.saves;

    await expect(service.update({ maxRetries: 99 })).rejects.toMatchObject({
      category: 'validation',
      code: 'settings-invalid-maxRetries',
    });

    expect(repository.saves).toBe(before);
    expect((await service.get()).maxRetries).toBe(DEFAULT_SETTINGS.maxRetries);
  });

  it('rejects an unknown setting', async () => {
    const { service } = setup();
    await expect(service.update({ telemetry: true } as never)).rejects.toMatchObject({
      code: 'settings-unknown-key',
    });
  });

  it('restores every default on reset', async () => {
    const { repository, service } = setup();
    await service.update({ theme: 'dark', keepHistory: false, maxRetries: 7 });
    const reset = await service.reset();
    expect(reset).toEqual(DEFAULT_SETTINGS);
    expect(repository.stored).toEqual(DEFAULT_SETTINGS);
  });

  it('degrades to the defaults and reports when storage cannot be read', async () => {
    const { repository, errors, service } = setup();
    repository.failLoad = true;
    expect(await service.get()).toEqual(DEFAULT_SETTINGS);
    expect(errors[0]).toMatchObject({ code: 'settings-load-failed' });
  });

  it('keeps the session consistent and reports when a write fails', async () => {
    const { repository, errors, service } = setup();
    repository.failSave = true;
    const applied = await service.update({ theme: 'dark' });
    expect(applied.theme).toBe('dark');
    expect((await service.get()).theme).toBe('dark');
    expect(errors[0]).toMatchObject({ code: 'settings-save-failed' });
  });

  it('works without an error sink', async () => {
    const repository = createFakeRepository();
    repository.failLoad = true;
    const service = createSettingsService({ repository });
    await expect(service.get()).resolves.toEqual(DEFAULT_SETTINGS);
  });
});

describe('core/storage settings repository', () => {
  it('stores the catalogue under one local key', async () => {
    const data = new Map<string, unknown>();
    const store = {
      get: <T>(key: string): Promise<T | undefined> =>
        Promise.resolve(data.get(key) as T | undefined),
      set: <T>(key: string, value: T): Promise<void> => {
        data.set(key, value);
        return Promise.resolve();
      },
      remove: (): Promise<void> => Promise.resolve(),
      getMany: (): Promise<Record<string, unknown>> => Promise.resolve({}),
      setMany: (): Promise<void> => Promise.resolve(),
      clear: (): Promise<void> => Promise.resolve(),
    };
    const repository = createSettingsRepository(store);

    expect(await repository.load()).toBeUndefined();
    await repository.save({ ...DEFAULT_SETTINGS, theme: 'dark' });

    expect([...data.keys()]).toEqual([SETTINGS_STORAGE_KEY]);
    expect(await repository.load()).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark' });
  });
});

describe('core/settings service: concurrent updates', () => {
  it('keeps both changes when two updates start before the first load resolves', async () => {
    // Both would otherwise read the same base catalogue and the second write would
    // drop the first one's change.
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const repository: SettingsRepository = {
      load: async () => {
        await gate;
        return undefined;
      },
      save: () => Promise.resolve(),
    };
    const service = createSettingsService({ repository });

    const first = service.update({ theme: 'dark' });
    const second = service.update({ maxRetries: 7 });
    release();
    await first;
    const settled = await second;

    expect(settled.theme).toBe('dark');
    expect(settled.maxRetries).toBe(7);
    expect(await service.get()).toMatchObject({ theme: 'dark', maxRetries: 7 });
  });

  it('a rejected update does not block the next one', async () => {
    const service = createSettingsService({
      repository: { load: () => Promise.resolve(undefined), save: () => Promise.resolve() },
    });

    await expect(service.update({ maxRetries: 999 })).rejects.toThrow();
    await expect(service.update({ maxRetries: 2 })).resolves.toMatchObject({ maxRetries: 2 });
  });
});
