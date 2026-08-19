/**
 * Module: platform/storage (implementation)
 * Purpose: Implement {@link StorageService} over normalized WebExtension storage
 *          areas (PROJECT_BIBLE.md §8.14). Typed get/set/batch/remove/clear,
 *          value validation, and versioned migration hooks. Local-only (§14).
 * Restrictions: Platform layer — adapts only. No domain schema (that is core).
 * Public API: createStorageService.
 */
import type { KeyValueStore, Migration, StorageAreaName, StorageService } from '@platform/storage';
import type { WebExtApi, WebExtStorageArea } from '@platform/browser/webext';
import { StorageError } from '@shared/result/errors';

/** Key under which each area records its applied schema version. */
const SCHEMA_VERSION_KEY = '__aetherdl_schema_version__';

/** Ensure a value can be persisted (throws on circular refs / BigInt, etc.). */
function assertSerializable(value: unknown): void {
  try {
    JSON.stringify(value);
  } catch (cause) {
    throw new StorageError('Value is not JSON-serializable', {
      code: 'storage-not-serializable',
      messageKey: 'error.storage.serialize',
      cause,
    });
  }
}

function wrapArea(area: WebExtStorageArea, label: StorageAreaName): KeyValueStore {
  const fail = (operation: string, cause: unknown): never => {
    throw new StorageError(`Storage ${operation} failed for area "${label}"`, {
      code: `storage-${operation}-failed`,
      messageKey: 'error.storage.operation',
      cause,
    });
  };

  return {
    async get<T>(key: string): Promise<T | undefined> {
      try {
        const record = await area.get(key);
        return record[key] as T | undefined;
      } catch (cause) {
        return fail('get', cause);
      }
    },
    async set<T>(key: string, value: T): Promise<void> {
      assertSerializable(value);
      try {
        await area.set({ [key]: value });
      } catch (cause) {
        fail('set', cause);
      }
    },
    async remove(key: string): Promise<void> {
      try {
        await area.remove(key);
      } catch (cause) {
        fail('remove', cause);
      }
    },
    async getMany(keys: readonly string[]): Promise<Record<string, unknown>> {
      try {
        return await area.get([...keys]);
      } catch (cause) {
        return fail('getMany', cause);
      }
    },
    async setMany(items: Record<string, unknown>): Promise<void> {
      assertSerializable(items);
      try {
        await area.set(items);
      } catch (cause) {
        fail('setMany', cause);
      }
    },
    async clear(): Promise<void> {
      try {
        await area.clear();
      } catch (cause) {
        fail('clear', cause);
      }
    },
  };
}

/** Create the storage service over a resolved WebExtension API. */
export function createStorageService(api: WebExtApi): StorageService {
  const local = wrapArea(api.storage.local, 'local');
  const sync = wrapArea(api.storage.sync, 'sync');
  const session =
    api.storage.session !== undefined ? wrapArea(api.storage.session, 'session') : undefined;

  const area = (name: StorageAreaName): KeyValueStore => {
    switch (name) {
      case 'local':
        return local;
      case 'sync':
        return sync;
      case 'session':
        if (session === undefined) {
          throw new StorageError('Session storage is unavailable on this target', {
            code: 'storage-session-unavailable',
            messageKey: 'error.storage.session',
          });
        }
        return session;
      default:
        throw new StorageError(`Unknown storage area "${String(name)}"`, {
          code: 'storage-unknown-area',
          messageKey: 'error.storage.area',
        });
    }
  };

  const runMigrations = async (
    name: StorageAreaName,
    migrations: readonly Migration[],
  ): Promise<void> => {
    const store = area(name);
    const current = (await store.get<number>(SCHEMA_VERSION_KEY)) ?? 0;
    const pending = migrations
      .filter((migration) => migration.version > current)
      .slice()
      .sort((a, b) => a.version - b.version);
    for (const migration of pending) {
      await migration.migrate(store);
      await store.set(SCHEMA_VERSION_KEY, migration.version);
    }
  };

  return { local, sync, session, area, runMigrations };
}
