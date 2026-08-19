/**
 * Module: core/history
 * Purpose: Local download-history service contract (PROJECT_BIBLE.md §4.11).
 *          Local-only, fully erasable; never transmitted (§14).
 * Restrictions: Domain layer — persistence via repositories (§8.14).
 * Dependencies: shared/types.
 * Public API: HistoryService.
 */
import type { HistoryRecord } from '@shared/types';

export interface HistoryService {
  record(entry: HistoryRecord): Promise<void>;
  list(): Promise<readonly HistoryRecord[]>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}
