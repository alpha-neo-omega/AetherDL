/**
 * Module: ui/settings (error presentation)
 * Purpose: Turn the shared {@link AppError} taxonomy into the plain-language copy
 *          the settings surface shows (PROJECT_BIBLE.md §20.3, §20.5).
 * Restrictions: UI layer — introduces NO new error hierarchy: it maps the ratified
 *          categories onto this surface's catalogue. Internal codes, causes and
 *          stack traces never reach the user (§20.5).
 * Public API: describeSettingsError.
 */
import type { AppError, ErrorCategory } from '@shared/result';
import type { ErrorDescription } from '@ui/popup';
import type { SettingsMessageKey, TranslateSettings } from './strings';

/**
 * The stable codes the settings service uses to reject a change (§4.9, §20.2).
 * Crossing the message boundary normalizes an error's category to `internal`, but
 * the machine code survives — so the rejection is recognized by code and the user
 * still gets the specific "that value is not allowed" copy rather than a generic
 * apology (§20.5).
 */
const VALIDATION_CODE = /^settings-(invalid|unknown)/;

const CATEGORY_MESSAGE: Readonly<Record<ErrorCategory, SettingsMessageKey>> = {
  network: 'settings.error.internal',
  http: 'settings.error.internal',
  drm: 'settings.error.internal',
  // A rejected setting is the common case here, so it gets the specific copy (§4.9).
  validation: 'settings.error.invalid',
  storage: 'settings.error.storage',
  permission: 'settings.error.permission',
  capability: 'settings.error.capability',
  internal: 'settings.error.internal',
};

/** Plain-language presentation for an error, with its recovery affordance (§20.5). */
export function describeSettingsError(error: AppError, t: TranslateSettings): ErrorDescription {
  const category: ErrorCategory = VALIDATION_CODE.test(error.code) ? 'validation' : error.category;
  return {
    title: t('settings.error.title'),
    detail: t(CATEGORY_MESSAGE[category]),
    retryable: error.retryable,
  };
}
