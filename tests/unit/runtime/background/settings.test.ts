import { describe, expect, it, vi } from 'vitest';
import { createBrowserFrom } from '@platform/browser/factory';
import { createMessageBus } from '@platform/messaging/service';
import { DEFAULT_SETTINGS } from '@core/settings';
import { createSettingsService } from '@core/settings/settings';
import { createHistoryService } from '@core/history/history';
import { createHistoryRepository } from '@core/storage/history-repository';
import type { SettingsRepository } from '@core/storage';
import { SETTINGS_CHANGED_CHANNEL } from '@shared/constants';
import type { AppError } from '@shared/result';
import type { HistoryRecord, Settings } from '@shared/types';
import {
  createBackgroundSettingsRuntime,
  HISTORY_EXPORT_VERSION,
} from '@runtime/background/settings';
import { createMemoryObjectStore } from '../../core/storage/_fixtures';
import { createFakeWebExt } from '../../platform/_fake-webext';

const NOW = 1_700_000_000_000;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function record(props: Partial<HistoryRecord> & { readonly id: string }): HistoryRecord {
  return {
    title: `Title ${props.id}`,
    kind: 'video',
    originHost: 'example.com',
    timestamp: NOW,
    outcome: 'completed',
    filename: `${props.id}.mp4`,
    ...props,
  };
}

function memorySettingsRepository(): SettingsRepository {
  let stored: Settings | undefined;
  return {
    load: () => Promise.resolve(stored),
    save: (next) => {
      stored = next;
      return Promise.resolve();
    },
  };
}

function setup() {
  const fake = createFakeWebExt();
  const browser = createBrowserFrom(fake.api, 'chrome');
  const store = createMemoryObjectStore();
  const settings = createSettingsService({ repository: memorySettingsRepository() });
  const history = createHistoryService({
    repository: createHistoryRepository({ store }),
    settings,
    clock: () => NOW,
    sessionStartedAt: NOW,
  });
  const runtime = createBackgroundSettingsRuntime({ browser, settings, history });
  runtime.start();
  const client = createMessageBus(fake.api);
  const broadcasts: Settings[] = [];
  client.onBroadcast(SETTINGS_CHANGED_CHANNEL, (payload) => {
    broadcasts.push(payload as Settings);
  });
  return { fake, browser, store, settings, history, runtime, client, broadcasts };
}

describe('background settings runtime', () => {
  it('answers settings/get with the normative defaults', async () => {
    const { client } = setup();
    expect(await client.send('settings/get', undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('applies, persists and announces a settings/update', async () => {
    const { client, settings, broadcasts, runtime } = setup();
    const changed = vi.fn();
    runtime.on('settings:changed', changed);

    const applied = await client.send('settings/update', { theme: 'dark' });
    await flush();

    expect(applied.theme).toBe('dark');
    expect((await settings.get()).theme).toBe('dark');
    expect(changed).toHaveBeenCalledWith(applied);
    expect(broadcasts).toEqual([applied]);
  });

  it('propagates a rejected change and announces nothing', async () => {
    const { client, broadcasts, runtime } = setup();
    const errors: AppError[] = [];
    runtime.on('error', (error) => errors.push(error));

    await expect(client.send('settings/update', { maxRetries: 99 })).rejects.toMatchObject({
      code: 'settings-invalid-maxRetries',
    });
    await flush();

    expect(broadcasts).toEqual([]);
    expect(errors[0]).toMatchObject({ category: 'validation' });
  });

  it('restores and announces the defaults on settings/reset', async () => {
    const { client, broadcasts } = setup();
    await client.send('settings/update', { theme: 'dark', keepHistory: false });
    const reset = await client.send('settings/reset', undefined);
    await flush();

    expect(reset).toEqual(DEFAULT_SETTINGS);
    expect(broadcasts.at(-1)).toEqual(DEFAULT_SETTINGS);
  });

  it('serves history/query newest first', async () => {
    const { client, history } = setup();
    await history.record(record({ id: 'a', timestamp: NOW - 10 }));
    await history.record(record({ id: 'b', timestamp: NOW }));

    const listed = await client.send('history/query', undefined);
    expect(listed.map((entry) => entry.id)).toEqual(['b', 'a']);
  });

  it('deletes one record and ignores a malformed request', async () => {
    const { client, history } = setup();
    await history.record(record({ id: 'a' }));
    await history.record(record({ id: 'b' }));

    await client.send('history/delete', { id: '' } as never);
    await client.send('history/delete', null as never);
    expect((await client.send('history/query', undefined)).length).toBe(2);

    await client.send('history/delete', { id: 'a' });
    expect((await client.send('history/query', undefined)).map((entry) => entry.id)).toEqual(['b']);
  });

  it('erases everything on history/clear', async () => {
    const { client, history, store } = setup();
    await history.record(record({ id: 'a' }));
    await client.send('history/clear', undefined);

    expect(await client.send('history/query', undefined)).toEqual([]);
    expect(store.records.size).toBe(0);
  });

  it('exports history as versioned, local JSON', async () => {
    const { client, history } = setup();
    await history.record(record({ id: 'a' }));

    const exported = await client.send('history/export', undefined);
    const parsed = JSON.parse(exported) as { version: number; records: HistoryRecord[] };

    expect(parsed.version).toBe(HISTORY_EXPORT_VERSION);
    expect(parsed.records.map((entry) => entry.id)).toEqual(['a']);
    expect(exported.endsWith('\n')).toBe(true);
  });

  it('forwards a core storage failure onto the runtime error stream', () => {
    const { runtime } = setup();
    const errors: AppError[] = [];
    runtime.on('error', (error) => errors.push(error));

    runtime.reportError({
      category: 'storage',
      code: 'history-load-failed',
      messageKey: 'error.storage.operation',
      retryable: false,
    });

    expect(errors[0]?.code).toBe('history-load-failed');
  });

  it('wraps an untyped handler failure and reports it before propagating', async () => {
    const fake = createFakeWebExt();
    const browser = createBrowserFrom(fake.api, 'chrome');
    const errors: AppError[] = [];
    const runtime = createBackgroundSettingsRuntime({
      browser,
      settings: {
        get: () => Promise.reject(new Error('service exploded')),
        update: () => Promise.reject(new Error('service exploded')),
        reset: () => Promise.reject(new Error('service exploded')),
      },
      history: {
        record: () => Promise.resolve(),
        list: () => Promise.resolve([]),
        delete: () => Promise.resolve(),
        clear: () => Promise.resolve(),
      },
    });
    runtime.start();
    runtime.on('error', (error) => errors.push(error));
    const client = createMessageBus(fake.api);

    await expect(client.send('settings/get', undefined)).rejects.toBeDefined();

    expect(errors[0]).toMatchObject({ category: 'internal', code: 'settings-get-failed' });
    runtime.dispose();
  });

  it('start is idempotent and dispose detaches every handler', async () => {
    const { client, runtime } = setup();
    runtime.start();
    expect(await client.send('settings/get', undefined)).toEqual(DEFAULT_SETTINGS);

    runtime.dispose();
    runtime.dispose();

    await expect(client.send('settings/get', undefined)).rejects.toMatchObject({
      code: 'messaging-no-response',
    });
  });
});
