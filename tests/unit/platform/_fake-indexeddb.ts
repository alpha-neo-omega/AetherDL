/**
 * Test double: a minimal in-memory IndexedDB implementing just the surface the
 * platform object-store adapter uses (open/upgrade, transactions, put/get/getAll/
 * delete/clear) with injectable failures. Requests settle asynchronously, like the
 * real API, so the adapter's promise plumbing is exercised for real.
 *
 * Not a test file — imported by the platform specs.
 */

type Handler = (() => void) | null;

class FakeRequest<T> {
  result!: T;
  error: Error | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
}

class FakeOpenRequest extends FakeRequest<FakeDatabase> {
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
}

class FakeObjectStoreNames {
  constructor(private readonly names: Set<string>) {}

  contains(name: string): boolean {
    return this.names.has(name);
  }
}

class FakeDatabase {
  readonly stores = new Map<string, Map<string, unknown>>();
  version = 0;
  /** When set, `transaction()` throws — mirrors an InvalidStateError. */
  throwOnTransaction: Error | undefined;
  /** When true, the FIRST `transaction()` throws and later ones succeed: what a
   *  connection that died underneath the adapter looks like once it reconnects. */
  throwOnTransactionOnce = false;
  /** When set, `objectStore()` throws — mirrors a NotFoundError. */
  throwOnObjectStore: Error | undefined;
  /** Operation names that must fail on their next call. */
  readonly failing = new Set<string>();
  /** Operation names whose transaction must abort on their next call. */
  readonly aborting = new Set<string>();

  /** Connections closed by the adapter, for asserting it releases the database. */
  closed = 0;
  /** Set by a connection that wants to be told about another connection's upgrade. */
  onversionchange: Handler = null;
  /** Set by a connection that wants to know when the browser closed it. */
  onclose: Handler = null;

  /** Simulate the browser closing this connection (storage cleared, db deleted). */
  closeFromBrowser(): void {
    this.throwOnTransactionOnce = true;
    this.onclose?.();
  }

  get objectStoreNames(): FakeObjectStoreNames {
    return new FakeObjectStoreNames(new Set(this.stores.keys()));
  }

  close(): void {
    this.closed += 1;
  }

  createObjectStore(name: string): void {
    this.stores.set(name, new Map<string, unknown>());
  }

  transaction(storeName: string, _mode: string): FakeTransaction {
    if (this.throwOnTransactionOnce) {
      this.throwOnTransactionOnce = false;
      throw new Error('InvalidStateError: the database connection is closing');
    }
    if (this.throwOnTransaction !== undefined) {
      throw this.throwOnTransaction;
    }
    const data = this.stores.get(storeName);
    if (data === undefined) {
      throw new Error(`No object store "${storeName}"`);
    }
    return new FakeTransaction(this, data);
  }
}

class FakeTransaction {
  error: Error | null = null;
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  private settled = false;

  constructor(
    private readonly db: FakeDatabase,
    private readonly data: Map<string, unknown>,
  ) {}

  objectStore(_name: string): FakeObjectStore {
    if (this.db.throwOnObjectStore !== undefined) {
      throw this.db.throwOnObjectStore;
    }
    return new FakeObjectStore(this, this.data);
  }

  /** Settle one issued request, then the transaction, on later microtasks. */
  settle<T>(request: FakeRequest<T>, operation: string, produce: () => T): void {
    queueMicrotask(() => {
      if (this.settled) {
        return;
      }
      if (this.db.aborting.delete(operation)) {
        this.settled = true;
        this.error = new Error(`fake indexeddb ${operation} aborted`);
        this.onabort?.();
        return;
      }
      if (this.db.failing.delete(operation)) {
        this.settled = true;
        const failure = new Error(`fake indexeddb ${operation} failed`);
        request.error = failure;
        request.onerror?.();
        this.error = failure;
        this.onerror?.();
        return;
      }
      request.result = produce();
      request.onsuccess?.();
      queueMicrotask(() => {
        if (!this.settled) {
          this.settled = true;
          this.oncomplete?.();
        }
      });
    });
  }
}

class FakeObjectStore {
  constructor(
    private readonly tx: FakeTransaction,
    private readonly data: Map<string, unknown>,
  ) {}

  put(value: unknown, key: string): FakeRequest<void> {
    const request = new FakeRequest<void>();
    this.tx.settle(request, 'put', () => {
      this.data.set(key, value);
    });
    return request;
  }

  get(key: string): FakeRequest<unknown> {
    const request = new FakeRequest<unknown>();
    this.tx.settle(request, 'get', () => this.data.get(key));
    return request;
  }

  getAll(): FakeRequest<unknown[]> {
    const request = new FakeRequest<unknown[]>();
    this.tx.settle(request, 'getAll', () => [...this.data.values()]);
    return request;
  }

  delete(key: string): FakeRequest<void> {
    const request = new FakeRequest<void>();
    this.tx.settle(request, 'delete', () => {
      this.data.delete(key);
    });
    return request;
  }

  clear(): FakeRequest<void> {
    const request = new FakeRequest<void>();
    this.tx.settle(request, 'clear', () => {
      this.data.clear();
    });
    return request;
  }
}

export interface FakeIndexedDb {
  /** Pass to the adapter as its IndexedDB entry point. */
  readonly factory: IDBFactory;
  /** Raw contents of a store, for assertions. */
  contents(databaseName: string, storeName: string): Map<string, unknown>;
  /** Fail the next call of an operation (`put` / `get` / `getAll` / `delete` / `clear`). */
  failNext(databaseName: string, operation: string): void;
  /** Abort the transaction of the next call of an operation. */
  abortNext(databaseName: string, operation: string): void;
  /** Make `transaction()` throw for the given database. */
  breakTransactions(databaseName: string, error: Error): void;
  /** Make `objectStore()` throw for the given database. */
  breakObjectStore(databaseName: string, error: Error): void;
  /** Reject the next `open()` outright. */
  failNextOpen(): void;
  /** Make the next `open()` throw synchronously. */
  throwOnNextOpen(): void;
  /** Make the next `open()` report a blocking older connection. */
  blockNextOpen(): void;
  /** Simulate another connection requesting an upgrade of this database. */
  versionChange(databaseName: string): void;
  /** Simulate the browser closing the connection (storage cleared, db deleted). */
  closeConnection(databaseName: string): void;
  /** How many times a connection to this database was closed. */
  closedConnections(databaseName: string): number;
  /** Number of `open()` calls made so far. */
  readonly opens: number;
}

export function createFakeIndexedDb(): FakeIndexedDb {
  const databases = new Map<string, FakeDatabase>();
  let failOpen = false;
  let throwOpen = false;
  let blockOpen = false;
  let opens = 0;

  const database = (name: string): FakeDatabase => {
    let db = databases.get(name);
    if (db === undefined) {
      db = new FakeDatabase();
      databases.set(name, db);
    }
    return db;
  };

  const factory = {
    open(name: string, version?: number): FakeOpenRequest {
      opens += 1;
      if (throwOpen) {
        throwOpen = false;
        throw new Error('fake indexeddb open threw');
      }
      const request = new FakeOpenRequest();
      const db = database(name);
      queueMicrotask(() => {
        if (failOpen) {
          failOpen = false;
          request.error = new Error('fake indexeddb open failed');
          request.onerror?.();
          return;
        }
        if (blockOpen) {
          blockOpen = false;
          request.onblocked?.();
          return;
        }
        request.result = db;
        if ((version ?? 1) > db.version) {
          db.version = version ?? 1;
          request.onupgradeneeded?.();
        }
        request.onsuccess?.();
      });
      return request;
    },
  };

  return {
    factory: factory as unknown as IDBFactory,
    contents(databaseName: string, storeName: string): Map<string, unknown> {
      return database(databaseName).stores.get(storeName) ?? new Map<string, unknown>();
    },
    /** Simulate another connection requesting an upgrade of this database. */
    closeConnection(databaseName: string): void {
      database(databaseName).closeFromBrowser();
    },
    versionChange(databaseName: string): void {
      database(databaseName).onversionchange?.();
    },
    /** How many times a connection to this database was closed. */
    closedConnections(databaseName: string): number {
      return database(databaseName).closed;
    },
    failNext(databaseName: string, operation: string): void {
      database(databaseName).failing.add(operation);
    },
    abortNext(databaseName: string, operation: string): void {
      database(databaseName).aborting.add(operation);
    },
    breakTransactions(databaseName: string, error: Error): void {
      database(databaseName).throwOnTransaction = error;
    },
    breakObjectStore(databaseName: string, error: Error): void {
      database(databaseName).throwOnObjectStore = error;
    },
    failNextOpen(): void {
      failOpen = true;
    },
    throwOnNextOpen(): void {
      throwOpen = true;
    },
    blockNextOpen(): void {
      blockOpen = true;
    },
    get opens(): number {
      return opens;
    },
  };
}
