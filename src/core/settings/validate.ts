/**
 * Module: core/settings (validation)
 * Purpose: Validate and repair the settings catalogue (PROJECT_BIBLE.md §4.9).
 *          Every setting has a sane, privacy-preserving default; invalid input is
 *          rejected with a clear, machine-readable reason, and unreadable stored
 *          values fall back to their default rather than corrupting the catalogue.
 * Restrictions: Domain layer — pure. No storage, no browser APIs, no UI (§8.4).
 *          The catalogue is exactly the ratified one: there is no "share usage data"
 *          setting and none can be added here (§4.9, §3).
 * Public API: SETTING_LIMITS, validateSettingsPatch, coerceSettings.
 */
import { err, ok, type AppError, type Result } from '@shared/result';
import { ValidationError } from '@shared/result/errors';
import { STREAM_QUALITY_PREFERENCES } from '@shared/constants';
import { DEFAULT_SETTINGS } from '@core/settings';
import type { Settings } from '@shared/types';

/** Normative bounds from the settings catalogue (§4.9). */
export const SETTING_LIMITS = {
  maxConcurrentDownloads: { min: 1, max: 10 },
  maxRetries: { min: 0, max: 10 },
  /** Keeps a template from growing unbounded; OS path limits apply later (§10.7). */
  filenameTemplateMaxLength: 200,
  downloadSubfolderMaxLength: 120,
} as const;

const THEMES = ['system', 'light', 'dark'] as const;
const RETENTIONS = ['forever', '30d', '90d', 'session'] as const;
const REDUCED_MOTION = ['system', 'on', 'off'] as const;
const SENSITIVITIES = ['conservative', 'balanced', 'aggressive'] as const;

/** `system` or a BCP-47-ish tag such as `en`, `en-GB` (§19.2). */
const LANGUAGE_PATTERN = /^(system|[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*)$/;

function invalid(key: keyof Settings, reason: string, value: unknown): AppError {
  return new ValidationError(`Invalid setting "${key}": ${reason}`, {
    code: `settings-invalid-${key}`,
    messageKey: 'error.settings.invalid',
    context: { setting: key, reason, received: typeof value },
  }).toAppError();
}

function isOneOf<T extends string>(options: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (options as readonly string[]).includes(value);
}

function isWholeNumberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** A subfolder must stay inside the browser downloads directory (§13.5, §10.7). */
function isSafeSubfolder(value: string): boolean {
  if (value.length > SETTING_LIMITS.downloadSubfolderMaxLength) {
    return false;
  }
  if (value === '') {
    return true;
  }
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    return false;
  }
  return normalized.split('/').every((segment) => segment !== '..' && !segment.includes(':'));
}

/** Per-setting predicates. Exhaustive by type: a new setting must be validated. */
const VALIDATORS: Readonly<{
  [K in keyof Settings]: (value: unknown) => value is Settings[K];
}> = {
  theme: (value): value is Settings['theme'] => isOneOf(THEMES, value),
  maxConcurrentDownloads: (value): value is number =>
    isWholeNumberInRange(
      value,
      SETTING_LIMITS.maxConcurrentDownloads.min,
      SETTING_LIMITS.maxConcurrentDownloads.max,
    ),
  maxRetries: (value): value is number =>
    isWholeNumberInRange(value, SETTING_LIMITS.maxRetries.min, SETTING_LIMITS.maxRetries.max),
  filenameTemplate: (value): value is string =>
    typeof value === 'string' &&
    value.trim() !== '' &&
    value.length <= SETTING_LIMITS.filenameTemplateMaxLength,
  downloadSubfolder: (value): value is string =>
    typeof value === 'string' && isSafeSubfolder(value),
  notifications: (value): value is boolean => typeof value === 'boolean',
  keepHistory: (value): value is boolean => typeof value === 'boolean',
  historyRetention: (value): value is Settings['historyRetention'] => isOneOf(RETENTIONS, value),
  duplicateWarnings: (value): value is boolean => typeof value === 'boolean',
  contextMenu: (value): value is boolean => typeof value === 'boolean',
  reducedMotion: (value): value is Settings['reducedMotion'] => isOneOf(REDUCED_MOTION, value),
  language: (value): value is string => typeof value === 'string' && LANGUAGE_PATTERN.test(value),
  streamQuality: (value): value is Settings['streamQuality'] =>
    isOneOf(STREAM_QUALITY_PREFERENCES, value),
  detectionSensitivity: (value): value is Settings['detectionSensitivity'] =>
    isOneOf(SENSITIVITIES, value),
};

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

/**
 * Look up a validator by an UNTRUSTED key, own properties only.
 *
 * `VALIDATORS[key]` reaches `Object.prototype` for names that live there: a patch key
 * of `constructor` or `toString` found a truthy function and was ACCEPTED as a
 * setting, and `__proto__` or `hasOwnProperty` threw a raw TypeError instead of being
 * reported as an unknown setting (§13.8).
 */
function validatorFor(key: string): ((candidate: unknown) => boolean) | undefined {
  return Object.prototype.hasOwnProperty.call(VALIDATORS, key)
    ? (VALIDATORS[key as keyof Settings] as (candidate: unknown) => boolean)
    : undefined;
}

/**
 * Validate a user-supplied patch (§4.9). Unknown keys are rejected rather than
 * silently dropped, so a typo never looks like a successful save.
 */
export function validateSettingsPatch(patch: unknown): Result<Partial<Settings>, AppError> {
  if (typeof patch !== 'object' || patch === null) {
    return err(
      new ValidationError('Settings patch must be an object', {
        code: 'settings-invalid-patch',
        messageKey: 'error.settings.invalid',
      }).toAppError(),
    );
  }
  const record = patch as Record<string, unknown>;
  const accepted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) {
      continue;
    }
    const validator = validatorFor(key);
    if (validator === undefined) {
      return err(
        new ValidationError(`Unknown setting "${key}"`, {
          code: 'settings-unknown-key',
          messageKey: 'error.settings.invalid',
          context: { setting: key },
        }).toAppError(),
      );
    }
    if (!validator(value)) {
      return err(invalid(key as keyof Settings, 'out of range or wrong type', value));
    }
    accepted[key] = value;
  }
  return ok(accepted as Partial<Settings>);
}

/**
 * Repair a stored catalogue: every value that fails validation (missing, stale
 * schema, hand-edited storage) reverts to its normative default, and nothing else
 * is carried over. Storage is never allowed to corrupt the running catalogue (§20.7).
 */
export function coerceSettings(stored: unknown): Settings {
  const record =
    typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
  const result: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    const validator = VALIDATORS[key] as (candidate: unknown) => boolean;
    // Own properties only: a stored catalogue is untrusted, and a value inherited
    // from a prototype is not a value the user set.
    const stored_value = Object.prototype.hasOwnProperty.call(record, key)
      ? record[key]
      : undefined;
    result[key] = validator(stored_value) ? stored_value : DEFAULT_SETTINGS[key];
  }
  return result as unknown as Settings;
}
