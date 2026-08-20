/**
 * Module: core/download (errors)
 * Purpose: Download-domain error classes, specializing the AppError taxonomy
 *          (PROJECT_BIBLE.md §20.2). Reuse the shared PlatformError base.
 * Restrictions: Domain layer — depends only on shared/ (§8.4).
 * Dependencies: shared/result (PlatformError, ErrorCategory).
 * Public API: DownloadValidationError, QueueError, RetryError, FilenameError,
 *          SchedulerError, PermissionDeniedError, StreamAssemblyError.
 */
import type { ErrorCategory } from '@shared/result';
import { PlatformError } from '@shared/result/errors';

/** A media item/URL failed download validation (§13.5, §20.3 `validation`). */
export class DownloadValidationError extends PlatformError {
  readonly category: ErrorCategory = 'validation';
}

/** An invalid queue operation or state transition (§20.3 `internal`). */
export class QueueError extends PlatformError {
  readonly category: ErrorCategory = 'internal';
}

/** A retry could not be scheduled or exceeded its limit (§20.3 `internal`). */
export class RetryError extends PlatformError {
  readonly category: ErrorCategory = 'internal';
}

/** A filename could not be generated/normalized safely (§10.7, §20.3 `validation`). */
export class FilenameError extends PlatformError {
  readonly category: ErrorCategory = 'validation';
}

/** The scheduler encountered an unexpected condition (§20.3 `internal`). */
export class SchedulerError extends PlatformError {
  readonly category: ErrorCategory = 'internal';
}

/** A required browser permission is missing/denied (§13.3, §20.3 `permission`). */
export class PermissionDeniedError extends PlatformError {
  readonly category: ErrorCategory = 'permission';
}

/**
 * HLS/DASH assembly could not produce a file (§10.6, §20.3 `network`). Also the
 * refusal carrier for an encrypted manifest: assembly stops and says so, and no key
 * is ever fetched or handled (§6, ADR-005).
 */
export class StreamAssemblyError extends PlatformError {
  readonly category: ErrorCategory = 'network';
}
