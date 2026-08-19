/**
 * Module: core/storage (history repository)
 * Purpose: The durable {@link HistoryRepository} over the platform structured
 *          store (PROJECT_BIBLE.md §8.14: history lives in IndexedDB).
 * Restrictions: Domain layer — persistence via the platform adapter only; no
 *          browser APIs, no IndexedDB details (§8.4). History is local-only and
 *          fully erasable: `clear()` removes every record, and nothing here can
 *          transmit anything (§14.1, §14.4). Stored records are untrusted and are
 *          validated before they re-enter the domain (§13.8).
 * Public API: HISTORY_DATABASE_NAME, HISTORY_STORE_NAME, createHistoryRepository.
 */
import type { ObjectStore } from '@platform/storage';
import type { HistoryRecord, MediaKind } from '@shared/types';
import type { HistoryRepository } from '@core/storage';

/** Database and object store holding local download history (§8.14). */
/**
 * History lives in its own database. Two stores in ONE database would have to agree
 * on a schema version, and each adapter only knows its own store: whichever opened
 * second would find its store missing and force an upgrade the first connection
 * blocks (§8.14).
 */
export const HISTORY_DATABASE_NAME = 'aetherdl-history';
export const HISTORY_STORE_NAME = 'download-history';

const KINDS: ReadonlySet<string> = new Set<MediaKind>([
  'video',
  'audio',
  'stream',
  'image-sequence',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Guard a stored record before it re-enters the domain (§13.8). */
function isHistoryRecord(value: unknown): value is HistoryRecord {
  if (!isRecord(value)) {
    return false;
  }
  const outcome = value['outcome'];
  return (
    typeof value['id'] === 'string' &&
    value['id'] !== '' &&
    typeof value['title'] === 'string' &&
    typeof value['kind'] === 'string' &&
    KINDS.has(value['kind']) &&
    typeof value['originHost'] === 'string' &&
    typeof value['filename'] === 'string' &&
    isFiniteNumber(value['timestamp']) &&
    (outcome === 'completed' || outcome === 'failed') &&
    (value['container'] === undefined || typeof value['container'] === 'string') &&
    (value['sizeBytes'] === undefined || isFiniteNumber(value['sizeBytes']))
  );
}

export interface HistoryRepositoryDeps {
  /**
   * The structured store. Typed `unknown` on purpose: persisted records are
   * untrusted until validated on load (§13.8).
   */
  readonly store: ObjectStore<unknown>;
}

export function createHistoryRepository(deps: HistoryRepositoryDeps): HistoryRepository {
  const { store } = deps;
  return {
    async load(): Promise<readonly HistoryRecord[]> {
      const raw = await store.getAll();
      return raw.filter(isHistoryRecord);
    },

    append(record: HistoryRecord): Promise<void> {
      return store.put(record.id, record);
    },

    delete(id: string): Promise<void> {
      return store.delete(id);
    },

    clear(): Promise<void> {
      return store.clear();
    },
  };
}
