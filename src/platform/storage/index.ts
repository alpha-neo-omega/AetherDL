/**
 * Module: platform/storage
 * Purpose: Typed adapter contracts for browser key-value storage across areas, plus
 *          migration hooks (PROJECT_BIBLE.md §8.14). Implementation in ./service.
 * Restrictions: Platform layer — depends only on shared/ (§8.4). Local-only (§14).
 * Dependencies: none.
 * Public API: KeyValueStore, ObjectStore, StorageAreaName, Migration, StorageService.
 */

/** Typed key-value store over a single storage area (§8.14). */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  /** Batch read: returns the raw record for the requested keys. */
  getMany(keys: readonly string[]): Promise<Record<string, unknown>>;
  /** Batch write. */
  setMany(items: Record<string, unknown>): Promise<void>;
  clear(): Promise<void>;
}

/** Structured object-store abstraction over IndexedDB (§8.14). Implemented Phase 5. */
export interface ObjectStore<T> {
  put(id: string, value: T): Promise<void>;
  get(id: string): Promise<T | undefined>;
  getAll(): Promise<readonly T[]>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

export type StorageAreaName = 'local' | 'sync' | 'session';

/** A single schema migration (§8.14). The core supplies concrete migrations later. */
export interface Migration {
  readonly version: number;
  migrate(store: KeyValueStore): Promise<void>;
}

export interface StorageService {
  readonly local: KeyValueStore;
  readonly sync: KeyValueStore;
  /** `undefined` when session storage is unavailable on this target (§7.2). */
  readonly session: KeyValueStore | undefined;
  /** Resolve an area by name; throws when the area is unavailable. */
  area(name: StorageAreaName): KeyValueStore;
  /** Run pending migrations against an area in ascending version order (§8.14). */
  runMigrations(name: StorageAreaName, migrations: readonly Migration[]): Promise<void>;
}
