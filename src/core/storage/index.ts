/**
 * Module: core/storage
 * Purpose: Repository contracts over platform storage adapters (PROJECT_BIBLE.md
 *          §8.14). All persistence flows through these; no surface touches storage
 *          or IndexedDB directly.
 * Restrictions: Domain/infrastructure layer — local-only, versioned/migrated (§8.14).
 * Dependencies: shared/types.
 * Public API: SettingsRepository, QueueRepository, HistoryRepository.
 */
import type { DownloadTask, HistoryRecord, Settings } from '@shared/types';

export interface SettingsRepository {
  load(): Promise<Settings | undefined>;
  save(settings: Settings): Promise<void>;
}

export interface QueueRepository {
  load(): Promise<readonly DownloadTask[]>;
  save(tasks: readonly DownloadTask[]): Promise<void>;
}

export interface HistoryRepository {
  load(): Promise<readonly HistoryRecord[]>;
  append(record: HistoryRecord): Promise<void>;
  /**
   * Remove one record. Phase 7 additive: the ratified HistoryService lets the user
   * delete individual records (§4.11), which this contract could not express; the
   * previous members are unchanged and this had no implementations.
   */
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}
