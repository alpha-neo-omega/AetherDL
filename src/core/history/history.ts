/**
 * Module: core/history (implementation)
 * Purpose: Implement {@link HistoryService} (PROJECT_BIBLE.md §4.11): record what
 *          the user downloaded, list it newest-first, delete a record, clear
 *          everything, and prune to the retention the user chose (§4.9).
 * Restrictions: Domain layer — persistence through the injected repository only
 *          (§8.14); no browser APIs, no UI (§8.4). History is LOCAL-ONLY and fully
 *          erasable: it is never transmitted anywhere (§14.1, §14.4). Recording is
 *          skipped entirely while "Keep history" is off, so opting out means no data
 *          is created rather than data being hidden (§2.10).
 * Public API: RETENTION_WINDOWS_MS, HistoryServiceDeps, createHistoryService.
 */
import type { AppError } from '@shared/result';
import { StorageError } from '@shared/result/errors';
import type { HistoryRecord, HistoryRetention } from '@shared/types';
import type { SettingsService } from '@core/settings';
import type { HistoryRepository } from '@core/storage';
import type { HistoryService } from '@core/history';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Retention windows in milliseconds; `undefined` means "no age limit" (§4.9). */
export const RETENTION_WINDOWS_MS: Readonly<Record<HistoryRetention, number | undefined>> = {
  forever: undefined,
  '30d': 30 * DAY_MS,
  '90d': 90 * DAY_MS,
  // `session` is not an age window: records are dropped when a new background
  // session starts, which is handled against the session start time below.
  session: undefined,
};

export interface HistoryServiceDeps {
  readonly repository: HistoryRepository;
  /** Supplies the "keep history" and retention choices (§4.9). */
  readonly settings: SettingsService;
  readonly clock: () => number;
  /** Start of this background session, used by the `session` retention policy. */
  readonly sessionStartedAt: number;
  /** Receives storage failures; history never takes the background down (§20.7). */
  readonly onError?: (error: AppError) => void;
}

export function createHistoryService(deps: HistoryServiceDeps): HistoryService {
  const { repository, settings, clock, sessionStartedAt } = deps;

  const report = (operation: string, cause: unknown): void => {
    deps.onError?.(
      new StorageError(`History ${operation} failed`, {
        code: `history-${operation}-failed`,
        messageKey: 'error.storage.operation',
        cause,
      }).toAppError(),
    );
  };

  /** The oldest timestamp a record may carry, or `undefined` to keep everything. */
  const cutoffFor = (retention: HistoryRetention): number | undefined => {
    if (retention === 'session') {
      return sessionStartedAt;
    }
    const window = RETENTION_WINDOWS_MS[retention];
    return window === undefined ? undefined : clock() - window;
  };

  const readAll = async (): Promise<readonly HistoryRecord[]> => {
    try {
      return await repository.load();
    } catch (cause) {
      report('load', cause);
      return [];
    }
  };

  /** Apply the retention policy, deleting anything that has aged out (§4.11). */
  const prune = async (records: readonly HistoryRecord[]): Promise<readonly HistoryRecord[]> => {
    const { historyRetention } = await settings.get();
    const cutoff = cutoffFor(historyRetention);
    if (cutoff === undefined) {
      return records;
    }
    const kept = records.filter((record) => record.timestamp >= cutoff);
    if (kept.length === records.length) {
      return records;
    }
    for (const expired of records) {
      if (expired.timestamp < cutoff) {
        try {
          await repository.delete(expired.id);
        } catch (cause) {
          report('prune', cause);
        }
      }
    }
    return kept;
  };

  return {
    async record(entry: HistoryRecord): Promise<void> {
      const { keepHistory } = await settings.get();
      if (!keepHistory) {
        return;
      }
      try {
        await repository.append(entry);
      } catch (cause) {
        report('append', cause);
        return;
      }
      await prune(await readAll());
    },

    async list(): Promise<readonly HistoryRecord[]> {
      const pruned = await prune(await readAll());
      // Newest first, with a stable id tiebreak so the order never wobbles.
      return [...pruned].sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
    },

    async delete(id: string): Promise<void> {
      try {
        await repository.delete(id);
      } catch (cause) {
        report('delete', cause);
      }
    },

    async clear(): Promise<void> {
      try {
        await repository.clear();
      } catch (cause) {
        report('clear', cause);
      }
    },
  };
}
