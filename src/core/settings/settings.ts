/**
 * Module: core/settings (implementation)
 * Purpose: Implement {@link SettingsService} (PROJECT_BIBLE.md §4.9): read the
 *          catalogue with normative defaults, validate every change, persist it
 *          locally, and hand back the applied result so callers apply it live.
 * Restrictions: Domain layer — persistence through the injected repository only;
 *          no browser APIs, no UI (§8.4, §8.14). Local-only: settings never leave
 *          the device (§14). An invalid change is rejected with a typed error and
 *          nothing is written (§4.9).
 * Public API: SettingsServiceDeps, createSettingsService.
 */
import type { AppError } from '@shared/result';
import { ValidationError } from '@shared/result/errors';
import type { Settings } from '@shared/types';
import type { SettingsRepository } from '@core/storage';
import type { SettingsService } from '@core/settings';
import { coerceSettings, validateSettingsPatch } from '@core/settings/validate';

export interface SettingsServiceDeps {
  readonly repository: SettingsRepository;
  /** Receives storage failures; the service keeps serving the in-memory catalogue. */
  readonly onError?: (error: AppError) => void;
}

export function createSettingsService(deps: SettingsServiceDeps): SettingsService {
  const { repository } = deps;
  /** The last known-good catalogue; `undefined` until the first load. */
  let cached: Settings | undefined;
  let loading: Promise<Settings> | undefined;

  const report = (operation: string, cause: unknown): void => {
    deps.onError?.(
      new ValidationError(`Settings ${operation} failed`, {
        code: `settings-${operation}-failed`,
        messageKey: 'error.storage.operation',
        cause,
      }).toAppError(),
    );
  };

  /**
   * Load once and reuse. A storage failure is reported and answered with the
   * normative defaults, so a broken store degrades to defaults rather than to a
   * surface with no settings at all (§20.7).
   */
  const load = async (): Promise<Settings> => {
    try {
      cached = coerceSettings(await repository.load());
    } catch (cause) {
      report('load', cause);
      cached = coerceSettings(undefined);
    }
    return cached;
  };

  const current = async (): Promise<Settings> => {
    if (cached !== undefined) {
      return cached;
    }
    loading ??= load().finally(() => {
      loading = undefined;
    });
    return loading;
  };

  const persist = async (next: Settings): Promise<Settings> => {
    // The in-memory catalogue advances first so a failed write still leaves the
    // session consistent with what the user was told (§2.8 honest state).
    cached = next;
    try {
      await repository.save(next);
    } catch (cause) {
      report('save', cause);
    }
    return next;
  };

  return {
    get(): Promise<Settings> {
      return current();
    },

    async update(patch: Partial<Settings>): Promise<Settings> {
      const validated = validateSettingsPatch(patch);
      if (!validated.ok) {
        // Reject the whole change: a half-applied catalogue is never written.
        throw new ValidationError(`Rejected settings change: ${validated.error.code}`, {
          code: validated.error.code,
          messageKey: validated.error.messageKey,
          ...(validated.error.context !== undefined && { context: validated.error.context }),
        });
      }
      const base = await current();
      return persist({ ...base, ...validated.value });
    },

    async reset(): Promise<Settings> {
      return persist(coerceSettings(undefined));
    },
  };
}
