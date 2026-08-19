/**
 * Module: core/storage (settings repository)
 * Purpose: The durable {@link SettingsRepository} over the platform key-value
 *          adapter (PROJECT_BIBLE.md §8.14: settings live in `storage.local`).
 * Restrictions: Domain layer — persistence via the platform adapter only; no
 *          browser APIs (§8.4). Local-only, never synced by default and never
 *          transmitted (§8.14, §14). Stored values are untrusted on read: the
 *          settings service repairs anything invalid against the defaults (§4.9).
 * Public API: SETTINGS_STORAGE_KEY, createSettingsRepository.
 */
import type { KeyValueStore } from '@platform/storage';
import type { Settings } from '@shared/types';
import type { SettingsRepository } from '@core/storage';

/** The single `storage.local` key holding the settings catalogue (§8.14). */
export const SETTINGS_STORAGE_KEY = 'aetherdl.settings';

export function createSettingsRepository(store: KeyValueStore): SettingsRepository {
  return {
    load(): Promise<Settings | undefined> {
      return store.get<Settings>(SETTINGS_STORAGE_KEY);
    },
    save(settings: Settings): Promise<void> {
      return store.set(SETTINGS_STORAGE_KEY, settings);
    },
  };
}
