import { describe, expect, it } from 'vitest';
import {
  createHistoryService,
  HISTORY_MAX_RECORDS,
  HISTORY_PRUNE_INTERVAL_MS,
  RETENTION_WINDOWS_MS,
} from '@core/history/history';
import { createHistoryRepository } from '@core/storage/history-repository';
import { createSettingsService } from '@core/settings/settings';
import type { SettingsRepository } from '@core/storage';
import type { AppError } from '@shared/result';
import type { HistoryRecord, Settings } from '@shared/types';
import { createMemoryObjectStore } from '../storage/_fixtures';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000 * DAY;

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

function settingsRepository(initial?: Partial<Settings>): SettingsRepository {
  let stored = initial as Settings | undefined;
  return {
    load: () => Promise.resolve(stored),
    save: (next) => {
      stored = next;
      return Promise.resolve();
    },
  };
}

function setup(initial?: Partial<Settings>) {
  const store = createMemoryObjectStore();
  const errors: AppError[] = [];
  const settings = createSettingsService({ repository: settingsRepository(initial) });
  const service = createHistoryService({
    repository: createHistoryRepository({ store }),
    settings,
    clock: () => NOW,
    sessionStartedAt: NOW - DAY,
    onError: (error) => errors.push(error),
  });
  return { store, errors, settings, service };
}

describe('core/history service', () => {
  it('records a download and lists it back', async () => {
    const { service } = setup();
    await service.record(record({ id: 'a' }));
    const listed = await service.list();
    expect(listed.map((entry) => entry.id)).toEqual(['a']);
  });

  it('lists newest first with a stable tiebreak', async () => {
    const { service } = setup();
    await service.record(record({ id: 'old', timestamp: NOW - 10 }));
    await service.record(record({ id: 'new', timestamp: NOW }));
    await service.record(record({ id: 'a-same', timestamp: NOW }));
    expect((await service.list()).map((entry) => entry.id)).toEqual(['a-same', 'new', 'old']);
  });

  it('records nothing at all while "keep history" is off', async () => {
    const { store, service } = setup({ keepHistory: false });
    await service.record(record({ id: 'a' }));
    expect(store.records.size).toBe(0);
    expect(await service.list()).toEqual([]);
  });

  it('starts recording again when the user turns history back on', async () => {
    const { settings, service } = setup({ keepHistory: false });
    await service.record(record({ id: 'a' }));
    await settings.update({ keepHistory: true });
    await service.record(record({ id: 'b' }));
    expect((await service.list()).map((entry) => entry.id)).toEqual(['b']);
  });

  it('deletes one record and clears them all', async () => {
    const { store, service } = setup();
    await service.record(record({ id: 'a' }));
    await service.record(record({ id: 'b' }));

    await service.delete('a');
    expect((await service.list()).map((entry) => entry.id)).toEqual(['b']);

    await service.clear();
    expect(await service.list()).toEqual([]);
    expect(store.records.size).toBe(0);
  });

  it('keeps everything under the forever policy', async () => {
    const { service } = setup({ historyRetention: 'forever' });
    await service.record(record({ id: 'ancient', timestamp: NOW - 900 * DAY }));
    expect((await service.list()).map((entry) => entry.id)).toEqual(['ancient']);
    expect(RETENTION_WINDOWS_MS.forever).toBeUndefined();
  });

  it.each([
    ['30d', 30],
    ['90d', 90],
  ] as const)('prunes past the %s window', async (retention, days) => {
    const { store, service } = setup({ historyRetention: retention });
    await service.record(record({ id: 'fresh', timestamp: NOW - (days - 1) * DAY }));
    await service.record(record({ id: 'stale', timestamp: NOW - (days + 1) * DAY }));

    expect((await service.list()).map((entry) => entry.id)).toEqual(['fresh']);
    // Pruning deletes durably, not just from the view (§4.11).
    expect([...store.records.keys()]).toEqual(['fresh']);
  });

  it('drops records from previous sessions under the session policy', async () => {
    const { service } = setup({ historyRetention: 'session' });
    await service.record(record({ id: 'this-session', timestamp: NOW }));
    await service.record(record({ id: 'last-session', timestamp: NOW - 2 * DAY }));
    expect((await service.list()).map((entry) => entry.id)).toEqual(['this-session']);
  });

  it('reports a read failure and answers with nothing rather than throwing', async () => {
    const { store, errors, service } = setup();
    store.failing.add('getAll');
    await expect(service.list()).resolves.toEqual([]);
    expect(errors[0]).toMatchObject({ category: 'storage', code: 'history-load-failed' });
  });

  it('reports a write failure without throwing', async () => {
    const { store, errors, service } = setup();
    store.failing.add('put');
    await expect(service.record(record({ id: 'a' }))).resolves.toBeUndefined();
    expect(errors[0]).toMatchObject({ code: 'history-append-failed' });
  });

  it('reports a failed delete and a failed clear', async () => {
    const { store, errors, service } = setup();
    store.failing.add('delete');
    await service.delete('missing');
    store.failing.add('clear');
    await service.clear();
    expect(errors.map((error) => error.code)).toEqual([
      'history-delete-failed',
      'history-clear-failed',
    ]);
  });

  it('reports a failed prune but still returns the surviving records', async () => {
    const { store, errors, service } = setup({ historyRetention: '30d' });
    await service.record(record({ id: 'fresh' }));
    store.records.set('stale', record({ id: 'stale', timestamp: NOW - 60 * DAY }));
    store.failing.add('delete');

    expect((await service.list()).map((entry) => entry.id)).toEqual(['fresh']);
    expect(errors[0]).toMatchObject({ code: 'history-prune-failed' });
  });

  it('works without an error sink', async () => {
    const store = createMemoryObjectStore();
    store.failing.add('getAll');
    const service = createHistoryService({
      repository: createHistoryRepository({ store }),
      settings: createSettingsService({ repository: settingsRepository() }),
      clock: () => NOW,
      sessionStartedAt: NOW,
    });
    await expect(service.list()).resolves.toEqual([]);
  });
});

describe('core/storage history repository', () => {
  it('round-trips a record', async () => {
    const store = createMemoryObjectStore();
    const repository = createHistoryRepository({ store });
    const entry = record({ id: 'a', container: 'mp4', sizeBytes: 1024 });

    await repository.append(entry);
    expect(await repository.load()).toEqual([entry]);
  });

  it('drops stored values that are not history records', async () => {
    const store = createMemoryObjectStore();
    const repository = createHistoryRepository({ store });
    store.records.set('good', record({ id: 'good' }));
    store.records.set('not-an-object', 42);
    store.records.set('bad-kind', { ...record({ id: 'bad-kind' }), kind: 'hologram' });
    store.records.set('bad-outcome', { ...record({ id: 'bad-outcome' }), outcome: 'maybe' });
    store.records.set('bad-time', { ...record({ id: 'bad-time' }), timestamp: 'yesterday' });
    store.records.set('bad-size', { ...record({ id: 'bad-size' }), sizeBytes: 'big' });
    store.records.set('bad-container', { ...record({ id: 'bad' }), container: 7 });
    store.records.set('empty-id', { ...record({ id: 'x' }), id: '' });

    expect((await repository.load()).map((entry) => entry.id)).toEqual(['good']);
  });

  it('deletes one record and clears the store', async () => {
    const store = createMemoryObjectStore();
    const repository = createHistoryRepository({ store });
    await repository.append(record({ id: 'a' }));
    await repository.append(record({ id: 'b' }));

    await repository.delete('a');
    expect((await repository.load()).map((entry) => entry.id)).toEqual(['b']);

    await repository.clear();
    expect(await repository.load()).toEqual([]);
  });
});

describe('core/history service: bounds (§12.1, §14.2)', () => {
  /** Like `setup`, but with a clock the test moves. */
  function bounded(initial?: Partial<Settings>) {
    const store = createMemoryObjectStore();
    let now = NOW;
    const settings = createSettingsService({ repository: settingsRepository(initial) });
    const service = createHistoryService({
      repository: createHistoryRepository({ store }),
      settings,
      clock: () => now,
      sessionStartedAt: NOW - DAY,
    });
    return {
      store,
      service,
      advance(ms: number): void {
        now += ms;
      },
      get now(): number {
        return now;
      },
    };
  }

  it('stops growing at the ceiling, keeping the newest records', async () => {
    // "Keep forever" is about time, not unbounded growth: without a ceiling the store
    // grew with every download for the life of the profile.
    const harness = bounded({ historyRetention: 'forever' });
    for (let index = 0; index < HISTORY_MAX_RECORDS + 5; index += 1) {
      harness.advance(1);
      await harness.service.record(record({ id: `r${String(index)}`, timestamp: harness.now }));
    }

    const listed = await harness.service.list();
    expect(listed).toHaveLength(HISTORY_MAX_RECORDS);
    // The five oldest were dropped, not the five newest.
    expect(listed[0]?.id).toBe(`r${String(HISTORY_MAX_RECORDS + 4)}`);
    expect(listed.at(-1)?.id).toBe('r5');
    expect(harness.store.records.size).toBe(HISTORY_MAX_RECORDS);
  });

  it('does not read the whole store for every download', async () => {
    // Regression: recording swept the store after every append — 51 full reads for 50
    // downloads, each one serialising every record.
    const harness = bounded({ historyRetention: 'forever' });
    for (let index = 0; index < 50; index += 1) {
      await harness.service.record(record({ id: `r${String(index)}` }));
    }

    const reads = harness.store.calls.filter((call) => call.startsWith('getAll')).length;
    expect(reads).toBeLessThanOrEqual(1);
    expect(harness.store.records.size).toBe(50);
  });

  it('sweeps on the first record, then throttles, then sweeps again', async () => {
    const harness = bounded({ historyRetention: '30d' });
    // The first record always sweeps: nothing is known about the store yet.
    await harness.service.record(record({ id: 'fresh', timestamp: NOW }));

    // Inside the interval a sweep is skipped, so an aged record is still on disk…
    await harness.service.record(record({ id: 'old', timestamp: NOW - 31 * DAY }));
    expect(harness.store.records.has('old')).toBe(true);

    harness.advance(HISTORY_PRUNE_INTERVAL_MS + 1);
    await harness.service.record(record({ id: 'newer', timestamp: harness.now }));

    // …and gone once the next sweep runs.
    expect(harness.store.records.has('old')).toBe(false);
    expect(harness.store.records.has('fresh')).toBe(true);
    expect(harness.store.records.has('newer')).toBe(true);
  });

  it('never SHOWS a record past its retention, swept or not', async () => {
    const harness = bounded({ historyRetention: '30d' });
    await harness.service.record(record({ id: 'old', timestamp: NOW - 31 * DAY }));

    // Listing always applies the window, so the promise the setting makes holds even
    // between sweeps.
    expect((await harness.service.list()).map((entry) => entry.id)).toEqual([]);
  });
});
