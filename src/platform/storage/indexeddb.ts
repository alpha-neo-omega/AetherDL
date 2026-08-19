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
      database = undefined;
      opening = undefined;
    };
    return ready;
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

  const read = async <R>(
    operation: string,
    body: (store: IDBObjectStore) => IDBRequest<R>,
  ): Promise<R> => {
    const connection = await connect();
    let transaction: IDBTransaction;
    try {
      transaction = connection.transaction(storeName, 'readonly');
    } catch (cause) {
      throw fail(operation, cause);
    }
    return fromRequest(body(transaction.objectStore(storeName)), operation);
  };

  /** Run a write and resolve only once its transaction commits (durability, §20.7). */
  const write = async (operation: string, body: (store: IDBObjectStore) => void): Promise<void> => {
    const connection = await connect();
    return new Promise<void>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = connection.transaction(storeName, 'readwrite');
      } catch (cause) {
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
