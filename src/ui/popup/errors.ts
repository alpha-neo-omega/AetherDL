/**
 * Module: ui/popup (error presentation)
 * Purpose: Normalize whatever a runtime call rejects with into the project's single
 *          {@link AppError} taxonomy, and turn that into plain-language, actionable
 *          user-facing text (PROJECT_BIBLE.md §20.2, §20.3, §20.5).
 * Restrictions: UI layer — introduces NO new error hierarchy: it reuses the shared
 *          taxonomy and maps categories to copy. Internal detail (stack traces,
 *          codes, causes) never reaches the user (§20.5); errors are never swallowed
 *          (§15.6) — every failure becomes a visible, dismissible notice.
 * Public API: toAppError, describeError, ErrorDescription.
 */
import type { AppError, ErrorCategory } from '@shared/result';
import { EN_MESSAGES, type MessageKey, type Translate } from './strings';

const CATEGORIES: ReadonlySet<string> = new Set<ErrorCategory>([
  'network',
  'http',
  'drm',
  'validation',
  'storage',
  'permission',
  'capability',
  'internal',
]);

function isAppError(value: unknown): value is AppError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['category'] === 'string' &&
    CATEGORIES.has(record['category']) &&
    typeof record['code'] === 'string' &&
    typeof record['messageKey'] === 'string' &&
    typeof record['retryable'] === 'boolean'
  );
}

/**
 * Coerce a rejection into an {@link AppError}. Typed errors that already carry the
 * taxonomy (including the platform error classes, which implement its shape) pass
 * through unchanged; anything else becomes an `internal` error (§20.4).
 */
export function toAppError(cause: unknown): AppError {
  if (isAppError(cause)) {
    return {
      category: cause.category,
      code: cause.code,
      messageKey: cause.messageKey,
      retryable: cause.retryable,
    };
  }
  return {
    category: 'internal',
    code: 'popup-unexpected',
    messageKey: 'error.internal',
    retryable: true,
  };
}

export interface ErrorDescription {
  readonly title: string;
  readonly detail: string;
  /** Whether the contract permits the user to try the action again (§20.3). */
  readonly retryable: boolean;
}

const CATEGORY_MESSAGE: Readonly<Record<ErrorCategory, MessageKey>> = {
  network: 'error.network',
  http: 'error.http',
  drm: 'error.drm',
  validation: 'error.validation',
  storage: 'error.storage',
  permission: 'error.permission',
  capability: 'error.capability',
  internal: 'error.internal',
};

/**
 * Plain-language presentation for an error, with its recovery affordance (§20.5).
 *
 * An error's own `messageKey` wins when the catalogue has that exact key: a category
 * covers a family, and some failures in a family need their own sentence (a declined
 * host permission is not the same as a missing downloads permission). Everything
 * else falls back to the category copy, so no error is ever left without text.
 */
export function describeError(error: AppError, t: Translate): ErrorDescription {
  const specific = Object.prototype.hasOwnProperty.call(EN_MESSAGES, error.messageKey)
    ? (error.messageKey as MessageKey)
    : undefined;
  return {
    title: t('error.title'),
    detail: t(specific ?? CATEGORY_MESSAGE[error.category]),
    retryable: error.retryable,
  };
}
