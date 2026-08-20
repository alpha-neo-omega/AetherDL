/**
 * Module: platform/storage (IndexedDB object store)
 * Purpose: Implement the declared {@link ObjectStore} contract over IndexedDB
 *          (PROJECT_BIBLE.md §8.14) — the backing store for structured, durable
 *          data such as the download queue. The schema is versioned: opening the
 *          database creates the object store on first use and on a version bump,
 *          and never drops existing data (§8.14, §14.6).
 * Restrictions: Platform layer — adapts only; holds no domain schema and no product
 *          logic. Local-only (§14). The database handle is opened lazily, reused for
 *          the life of the context, and released by the browser on teardown (§8.9).
 *          The IndexedDB entry point is injectable so targets and tests can supply
 *          their own (§7.2).
 * Public API: IndexedDbObjectStoreOptions, createIndexedDbObjectStore.
 */
import type { ObjectStore } from '@platform/storage';
import { StorageError } from '@shared/result/errors';

export interface IndexedDbObjectStoreOptions {
  readonly databaseName: string;
  readonly storeName: string;
  /** Schema version; a bump runs the upgrade path (§14.6). Defaults to 1. */
  readonly version?: number;
  /** The IndexedDB entry point; defaults to the ambient global (§7.2). */
  readonly factory?: IDBFactory;
}

function fail(operation: string, cause: unknown): StorageError {
  return new StorageError(`IndexedDB ${operation} failed`, {
    code: `storage-idb-${operation}-failed`,
    messageKey: 'error.storage.operation',
    cause,
  });
}

/** Await a single IndexedDB request, mapping its failure to a StorageError (§20.2). */
function fromRequest<R>(request: IDBRequest<R>, operation: string): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    request.onsuccess = (): void => {
      resolve(request.result);
    };
    request.onerror = (): void => {
      reject(fail(operation, request.error));
    };
  });
}

export function createIndexedDbObjectStore<T>(
  options: IndexedDbObjectStoreOptions,
): ObjectStore<T> {
  const { databaseName, storeName } = options;
  const version = options.version ?? 1;
  let database: IDBDatabase | undefined;
  let opening: Promise<IDBDatabase> | undefined;
  /** Set only when a cached handle turned out to be dead; see `withReconnect`. */
  let connectionLost = false;

  const resolveFactory = (): IDBFactory | undefined =>
    options.factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;

  const openDatabase = (atVersion: number): Promise<IDBDatabase> =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const factory = resolveFactory();
      if (factory === undefined) {
        reject(
          new StorageError('IndexedDB is unavailable in this context', {
            code: 'storage-idb-unavailable',
            messageKey: 'error.storage.operation',
          }),
        );
        return;
      }
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(databaseName, atVersion);
      } catch (cause) {
        reject(fail('open', cause));
        return;
      }
      request.onupgradeneeded = (): void => {
        // Create the store only when absent so an upgrade never drops user data (§14.6).
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName);
        }
      };
      request.onblocked = (): void => {
        reject(fail('open-blocked', new Error('An older connection blocked the upgrade')));
      };
      request.onsuccess = (): void => {
        resolve(request.result);
      };
      request.onerror = (): void => {
        reject(fail('open', request.error));
      };
    });

  /**
   * Open the database and guarantee this store exists inside it.
   *
   * `onupgradeneeded` fires only when the version rises, so a database that already
   * exists WITHOUT this store would otherwise never gain it and every read/write
   * against it would fail. When the store is missing, reopen one version higher so
   * the upgrade path creates it; existing stores and their data are untouched
   * (§14.6).
   */
  const openWithStore = async (): Promise<IDBDatabase> => {
    const opened = await openDatabase(version);
    const ready = opened.objectStoreNames.contains(storeName)
      ? opened
      : await (async (): Promise<IDBDatabase> => {
          opened.close();
          return openDatabase(opened.version + 1);
        })();
    // Never hold a database open against someone else's upgrade: an unanswered
    // `versionchange` blocks the other connection indefinitely. Drop ours and let
    // the next operation reconnect (§20.7).
    ready.onversionchange = (): void => {
      ready.close();
      forget(ready);
    };
    // A connection can also die WITHOUT a version change — the profile's storage is
    // cleared, the database is deleted, the browser forces it shut. Keeping the dead
    // handle cached made every later read and write fail for the rest of the session,
    // so the queue silently stopped persisting (§20.7).
    ready.onclose = (): void => {
      forget(ready);
    };
    return ready;
  };

  /** Drop a handle we must not use again, so the next call reconnects. */
  const forget = (dead?: IDBDatabase): void => {
    if (dead === undefined || database === dead) {
      database = undefined;
      opening = undefined;
    }
  };

  /** Open once and reuse; a failed open is not cached so a later call can retry. */
  const connect = async (): Promise<IDBDatabase> => {
    if (database !== undefined) {
      return database;
    }
    opening ??= openWithStore();
    try {
      database = await opening;
      return database;
    } catch (cause) {
      opening = undefined;
      throw cause;
    }
  };

  const readOnce = async <R>(
    operation: string,
    body: (store: IDBObjectStore) => IDBRequest<R>,
  ): Promise<R> => {
    const connection = await connect();
    let transaction: IDBTransaction;
    try {
      transaction = connection.transaction(storeName, 'readonly');
    } catch (cause) {
      // The handle is unusable; drop it so the retry opens a fresh one.
      forget(connection);
      connectionLost = true;
      throw fail(operation, cause);
    }
    return new Promise<R>((resolve, reject) => {
      // A transaction can abort on its own (storage eviction, a forced close). Without
      // this the promise would depend entirely on the request firing, so a settled
      // outcome is guaranteed here rather than assumed.
      transaction.onabort = (): void => {
        reject(fail(operation, transaction.error));
      };
      transaction.onerror = (): void => {
        reject(fail(operation, transaction.error));
      };
      fromRequest(body(transaction.objectStore(storeName)), operation).then(resolve, reject);
    });
  };

  /**
   * Run an operation, and if it failed because the cached CONNECTION was dead, run it
   * once more against a fresh one. Only that case is retried: an open that failed, a
   * request that errored, or a transaction that aborted is a real failure and must
   * surface as one rather than be tried again behind the caller's back. One retry,
   * never a loop.
   */
  const withReconnect = async <R>(attempt: () => Promise<R>): Promise<R> => {
    connectionLost = false;
    try {
      return await attempt();
    } catch (cause) {
      if (!connectionLost) {
        throw cause;
      }
      connectionLost = false;
      return attempt();
    }
  };

  const read = <R>(operation: string, body: (store: IDBObjectStore) => IDBRequest<R>): Promise<R> =>
    withReconnect(() => readOnce(operation, body));

  /** Run a write and resolve only once its transaction commits (durability, §20.7). */
  const writeOnce = async (
    operation: string,
    body: (store: IDBObjectStore) => void,
  ): Promise<void> => {
    const connection = await connect();
    return new Promise<void>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = connection.transaction(storeName, 'readwrite');
      } catch (cause) {
        forget(connection);
        connectionLost = true;
        reject(fail(operation, cause));
        return;
      }
      transaction.oncomplete = (): void => {
        resolve();
      };
      transaction.onerror = (): void => {
        reject(fail(operation, transaction.error));
      };
      transaction.onabort = (): void => {
        reject(fail(operation, transaction.error));
      };
      try {
        body(transaction.objectStore(storeName));
      } catch (cause) {
        reject(fail(operation, cause));
      }
    });
  };

  const write = (operation: string, body: (store: IDBObjectStore) => void): Promise<void> =>
    withReconnect(() => writeOnce(operation, body));

  return {
    put(id: string, value: T): Promise<void> {
      return write('put', (store) => {
        // Out-of-line keys: the store carries no keyPath, so the id is explicit.
        store.put(value, id);
      });
    },

    get(id: string): Promise<T | undefined> {
      return read<T | undefined>('get', (store) => store.get(id) as IDBRequest<T | undefined>);
    },

    getAll(): Promise<readonly T[]> {
      return read<T[]>('get-all', (store) => store.getAll() as IDBRequest<T[]>);
    },

    delete(id: string): Promise<void> {
      return write('delete', (store) => {
        store.delete(id);
      });
    },

    clear(): Promise<void> {
      return write('clear', (store) => {
        store.clear();
      });
    },
  };
}
