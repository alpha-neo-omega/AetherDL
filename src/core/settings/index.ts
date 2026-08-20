/**
 * Module: core/settings
 * Purpose: Settings service contract and normative default settings
 *          (PROJECT_BIBLE.md §4.9). Defaults are privacy-preserving by design (§14).
 * Restrictions: Domain layer — persistence via repositories (§8.14); validation
 *          rejects invalid values in the implementation (Phase 7).
 * Dependencies: shared/types, shared/constants.
 * Public API: DEFAULT_SETTINGS, SettingsService.
 */
import {
  DEFAULT_FILENAME_TEMPLATE,
  MAX_CONCURRENT_DOWNLOADS_DEFAULT,
  MAX_RETRIES_DEFAULT,
} from '@shared/constants';
import type { Settings } from '@shared/types';

/** Normative default settings (PROJECT_BIBLE.md §4.9). */
export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  maxConcurrentDownloads: MAX_CONCURRENT_DOWNLOADS_DEFAULT,
  maxRetries: MAX_RETRIES_DEFAULT,
  filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
  downloadSubfolder: '',
  notifications: true,
  keepHistory: true,
  historyRetention: 'forever',
  duplicateWarnings: true,
  contextMenu: true,
  reducedMotion: 'system',
  language: 'system',
  detectionSensitivity: 'balanced',
  // Highest by default: the user asked to download the media, and quietly saving a
  // worse copy than the one on offer would be the wrong kind of helpful (§10.6).
  streamQuality: 'highest',
};

export interface SettingsService {
  get(): Promise<Settings>;
  update(patch: Partial<Settings>): Promise<Settings>;
  reset(): Promise<Settings>;
}
