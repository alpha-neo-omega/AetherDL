/**
 * Module: shared/result (platform error taxonomy)
 * Purpose: Concrete error classes for the platform layer, implementing the AppError
 *          taxonomy (PROJECT_BIBLE.md §20.2). The error taxonomy is defined in
 *          shared/result (§20.2), so these classes live here as its specializations.
 * Responsibilities: Provide typed, throwable errors that carry category/code/
 *          messageKey/retryable and convert to a plain AppError (§20.4).
 * Restrictions: Leaf layer — depends only on the sibling result types (§8.16).
 * Dependencies: shared/result (AppError, ErrorCategory).
 * Public API: PlatformError, StorageError, PermissionError, MessagingError,
 *          RuntimeError, DownloadError, TabError, ValidationError.
 *
 * Note: imported via the subpath `@shared/result/errors` (not re-exported from the
 * result index) to keep the dependency edge one-way and cycle-free.
 */
import type { AppError, ErrorCategory } from '@shared/result';

export interface PlatformErrorOptions {
  readonly code: string;
  readonly messageKey: string;
  readonly retryable?: boolean;
  readonly cause?: unknown;
  readonly context?: Readonly<Record<string, unknown>>;
}

/** Base class for all platform errors. Implements the AppError shape (§20.2). */
export abstract class PlatformError extends Error implements AppError {
  abstract readonly category: ErrorCategory;
  readonly code: string;
  readonly messageKey: string;
  readonly retryable: boolean;
  override readonly cause?: unknown;
  readonly context?: Readonly<Record<string, unknown>>;

  constructor(message: string, options: PlatformErrorOptions) {
    super(message);
    this.name = new.target.name;
    this.code = options.code;
    this.messageKey = options.messageKey;
    this.retryable = options.retryable ?? false;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
    if (options.context !== undefined) {
      this.context = options.context;
    }
  }

  /** Convert to a plain, serializable AppError (§20.4). */
  toAppError(): AppError {
    const base: AppError = {
      category: this.category,
      code: this.code,
      messageKey: this.messageKey,
      retryable: this.retryable,
    };
    const withCause = this.cause !== undefined ? { ...base, cause: this.cause } : base;
    return this.context !== undefined ? { ...withCause, context: this.context } : withCause;
  }
}

/** Storage/persistence failure (§20.3 `storage`). */
export class StorageError extends PlatformError {
  readonly category: ErrorCategory = 'storage';
}

/** Missing/denied permission (§20.3 `permission`). */
export class PermissionError extends PlatformError {
  readonly category: ErrorCategory = 'permission';
}

/** Cross-context messaging failure (§20.3 `internal`). */
export class MessagingError extends PlatformError {
  readonly category: ErrorCategory = 'internal';
}

/** Runtime/environment failure (§20.3 `internal`). */
export class RuntimeError extends PlatformError {
  readonly category: ErrorCategory = 'internal';
}

/** Native download failure (§20.3 `http`). */
export class DownloadError extends PlatformError {
  readonly category: ErrorCategory = 'http';
}

/** Tab/window access failure or unavailable capability (§20.3 `capability`). */
export class TabError extends PlatformError {
  readonly category: ErrorCategory = 'capability';
}

/** Invalid input/argument (§20.3 `validation`). */
export class ValidationError extends PlatformError {
  readonly category: ErrorCategory = 'validation';
}
