import { describe, expect, it } from 'vitest';
import { createIndexedDbObjectStore } from '@platform/storage/indexeddb';
import { createFakeIndexedDb } from './_fake-indexeddb';

const DB = 'aetherdl-test';
const STORE = 'records';

function setup(): {
  readonly idb: ReturnType<typeof createFakeIndexedDb>;
  readonly store: ReturnType<typeof createIndexedDbObjectStore<{ readonly n: number }>>;
} {
  const idb = createFakeIndexedDb();
  const store = createIndexedDbObjectStore<{ readonly n: number }>({
    databaseName: DB,
    storeName: STORE,
    factory: idb.factory,
  });
  return { idb, store };
}

describe('platform/storage indexeddb object store', () => {
  it('creates the object store on first open and round-trips a value', async () => {
    const { idb, store } = setup();
    await store.put('a', { n: 1 });
    expect(await store.get('a')).toEqual({ n: 1 });
    expect(idb.contents(DB, STORE).get('a')).toEqual({ n: 1 });
  });

  it('returns undefined for an unknown key', async () => {
    const { store } = setup();
    await store.put('a', { n: 1 });
    expect(await store.get('missing')).toBeUndefined();
  });

  it('lists every stored value', async () => {
    const { store } = setup();
    await store.put('a', { n: 1 });
    await store.put('b', { n: 2 });
    expect(await store.getAll()).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('overwrites an existing key', async () => {
    const { store } = setup();
    await store.put('a', { n: 1 });
    await store.put('a', { n: 9 });
    expect(await store.getAll()).toEqual([{ n: 9 }]);
  });

  it('deletes a single record and clears the store', async () => {
    const { store } = setup();
    await store.put('a', { n: 1 });
    await store.put('b', { n: 2 });
    await store.delete('a');
    expect(await store.getAll()).toEqual([{ n: 2 }]);
    await store.clear();
    expect(await store.getAll()).toEqual([]);
  });

  it('opens the database once and reuses the connection', async () => {
    const { idb, store } = setup();
    await store.put('a', { n: 1 });
    await store.get('a');
    await store.getAll();
    expect(idb.opens).toBe(1);
  });

  it('reports a StorageError when IndexedDB is unavailable', async () => {
    const store = createIndexedDbObjectStore<number>({ databaseName: DB, storeName: STORE });
    await expect(store.getAll()).rejects.toMatchObject({
      category: 'storage',
      code: 'storage-idb-unavailable',
    });
  });

  it('surfaces an open failure and retries the open on the next call', async () => {
    const { idb, store } = setup();
    idb.failNextOpen();
    await expect(store.getAll()).rejects.toMatchObject({
      category: 'storage',
      code: 'storage-idb-open-failed',
    });
    await store.put('a', { n: 1 });
    expect(await store.getAll()).toEqual([{ n: 1 }]);
    expect(idb.opens).toBe(2);
  });

  it('surfaces an open that throws synchronously', async () => {
    const { idb, store } = setup();
    idb.throwOnNextOpen();
    await expect(store.getAll()).rejects.toMatchObject({ code: 'storage-idb-open-failed' });
  });

  it('surfaces an aborted write transaction', async () => {
    const { idb, store } = setup();
    await store.put('a', { n: 1 });
    idb.abortNext(DB, 'put');
    await expect(store.put('b', { n: 2 })).rejects.toMatchObject({
      code: 'storage-idb-put-failed',
    });
  });

  it('surfaces a write whose object store cannot be opened', async () => {
    const { idb, store } = setup();
    await store.put('a', { n: 1 });
    idb.breakObjectStore(DB, new Error('missing store'));
    await expect(store.delete('a')).rejects.toMatchObject({
      code: 'storage-idb-delete-failed',
    });
  });

  it('surfaces a blocked upgrade as a StorageError', async () => {
    const { idb, store } = setup();
    idb.blockNextOpen();
    await expect(store.getAll()).rejects.toMatchObject({
      code: 'storage-idb-open-blocked-failed',
    });
  });

  it('surfaces a failed read', async () => {
    const { idb, store } = setup();
    await store.put('a', { n: 1 });
    idb.failNext(DB, 'get');
    await expect(store.get('a')).rejects.toMatchObject({ code: 'storage-idb-get-failed' });
  });

  it('surfaces a failed write and leaves the store usable', async () => {
    const { idb, store } = setup();
    idb.failNext(DB, 'put');
    await expect(store.put('a', { n: 1 })).rejects.toMatchObject({
      code: 'storage-idb-put-failed',
    });
    await store.put('b', { n: 2 });
    expect(await store.getAll()).toEqual([{ n: 2 }]);
  });

  it('surfaces a transaction that cannot be opened, for reads and writes', async () => {
    const { idb, store } = setup();
    await store.put('a', { n: 1 });
    idb.breakTransactions(DB, new Error('closing'));
    await expect(store.get('a')).rejects.toMatchObject({ code: 'storage-idb-get-failed' });
    await expect(store.clear()).rejects.toMatchObject({ code: 'storage-idb-clear-failed' });
  });
});

describe('platform/storage indexeddb: a database it does not own alone', () => {
  it('adds its store to a database that already exists without it', async () => {
    const idb = createFakeIndexedDb();
    // Another component got there first and created only its own store.
    const first = createIndexedDbObjectStore<{ readonly n: number }>({
      databaseName: DB,
      storeName: 'other-store',
      factory: idb.factory,
    });
    await first.put('x', { n: 0 });

    const second = createIndexedDbObjectStore<{ readonly n: number }>({
      databaseName: DB,
      storeName: STORE,
      factory: idb.factory,
    });
    await second.put('a', { n: 1 });

    // The second store is created by a version bump rather than silently missing —
    // without this, every read and write against it fails (§8.14).
    expect(await second.get('a')).toEqual({ n: 1 });
    expect(idb.contents(DB, STORE).get('a')).toEqual({ n: 1 });
    // …and the first store's data survives the upgrade (§14.6).
    expect(idb.contents(DB, 'other-store').get('x')).toEqual({ n: 0 });
  });

  it('releases the database when another connection needs to upgrade it', async () => {
    const idb = createFakeIndexedDb();
    const store = createIndexedDbObjectStore<{ readonly n: number }>({
      databaseName: DB,
      storeName: STORE,
      factory: idb.factory,
    });
    await store.put('a', { n: 1 });

    // A held connection that ignores `versionchange` blocks the other connection's
    // upgrade forever, which deadlocks the background (§20.7).
    idb.versionChange(DB);
    expect(idb.closedConnections(DB)).toBe(1);

    // The next operation reconnects transparently.
    expect(await store.get('a')).toEqual({ n: 1 });
  });
});

describe('platform/storage: a connection that dies underneath the adapter', () => {
  it('reconnects and completes the write instead of failing for the rest of the session', async () => {
    // Regression: the dead handle stayed cached, so every later read and write failed
    // until the worker restarted — the queue silently stopped persisting (§20.7).
    const fake = createFakeIndexedDb();
    const store = createIndexedDbObjectStore<{ v: number }>({
      databaseName: 'aetherdl-probe',
      storeName: 'items',
      factory: fake.factory,
    });

    await store.put('a', { v: 1 });
    fake.closeConnection('aetherdl-probe');

    await expect(store.put('b', { v: 2 })).resolves.toBeUndefined();
    await expect(store.get('b')).resolves.toEqual({ v: 2 });
    // Exactly one extra open: the retry, not a loop.
    expect(fake.contents('aetherdl-probe', 'items').size).toBe(2);
  });

  it('recovers a read the same way', async () => {
    const fake = createFakeIndexedDb();
    const store = createIndexedDbObjectStore<{ v: number }>({
      databaseName: 'aetherdl-probe',
      storeName: 'items',
      factory: fake.factory,
    });

    await store.put('a', { v: 1 });
    fake.closeConnection('aetherdl-probe');

    await expect(store.getAll()).resolves.toEqual([{ v: 1 }]);
  });

  it('still reports a store that is genuinely broken, rather than retrying forever', async () => {
    const fake = createFakeIndexedDb();
    const store = createIndexedDbObjectStore<{ v: number }>({
      databaseName: 'aetherdl-probe',
      storeName: 'items',
      factory: fake.factory,
    });
    await store.put('a', { v: 1 });
    fake.breakTransactions('aetherdl-probe', new Error('InvalidStateError: gone'));

    await expect(store.put('b', { v: 2 })).rejects.toMatchObject({
      code: 'storage-idb-put-failed',
    });
  });
});

describe('platform/storage: a read transaction that aborts on its own', () => {
  it('rejects rather than leaving the caller waiting', async () => {
    // A transaction can abort without any request erroring (storage eviction, a
    // forced close). A read that never settles would hang queue hydration, and with
    // it every download message handler.
    const fake = createFakeIndexedDb();
    const store = createIndexedDbObjectStore<{ v: number }>({
      databaseName: 'aetherdl-probe',
      storeName: 'items',
      factory: fake.factory,
    });
    await store.put('a', { v: 1 });
    fake.abortNext('aetherdl-probe', 'getAll');

    const outcome = await Promise.race([
      store.getAll().then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise((resolve) => {
        setTimeout(() => resolve('hung'), 200);
      }),
    ]);

    expect(outcome).toBe('rejected');
  });
});
