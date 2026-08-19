/**
 * Module: shared/result
 * Purpose: The `Result<T, E>` type and canonical error taxonomy used for expected
 *          failures across the codebase (PROJECT_BIBLE.md §20.2, §20.4).
 * Responsibilities: Define AppError, ErrorCategory, Result, and pure constructors.
 * Restrictions: Leaf layer — no internal dependencies, no side effects (§8.16).
 * Dependencies: none.
 * Public API: ErrorCategory, AppError, Result, ok, err, isOk, isErr.
 */

/** Error categories that drive user-facing behavior and retry policy (§20.3). */
export type ErrorCategory =
  'network' | 'http' | 'drm' | 'validation' | 'storage' | 'permission' | 'capability' | 'internal';

/** The single canonical error shape (PROJECT_BIBLE.md §20.2). */
export interface AppError {
  readonly category: ErrorCategory;
  /** Stable machine code, e.g. `http-403`. */
  readonly code: string;
  /** i18n key for user-facing text (§19). */
  readonly messageKey: string;
  /** Whether the retry policy may retry this failure (§10.4). */
  readonly retryable: boolean;
  /** Original error — developer diagnostics only, never surfaced (§20.5). */
  readonly cause?: unknown;
  /** Safe, non-PII contextual data. */
  readonly context?: Readonly<Record<string, unknown>>;
}

/** Discriminated success/failure result. */
export type Result<T, E = AppError> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: E;
    };

/** Construct a success result. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Construct a failure result. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Type guard for the success arm. */
export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

/** Type guard for the failure arm. */
export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return !result.ok;
}
