/**
 * Module: core/detection (errors)
 * Purpose: Detection-domain error classes, specializing the AppError taxonomy
 *          (PROJECT_BIBLE.md §20.2). Reuses the shared PlatformError base so all
 *          errors share one shape.
 * Restrictions: Domain layer — depends only on shared/ (§8.4).
 * Dependencies: shared/result (PlatformError, ErrorCategory).
 * Public API: DetectionError, DetectorFailure, ValidationFailure, UnsupportedMedia,
 *          DuplicateMedia, ManifestError, MediaSourceError, CorrelationError,
 *          MetadataError, NetworkObservationError.
 */
import type { ErrorCategory } from '@shared/result';
import { PlatformError } from '@shared/result/errors';

/** A general failure of the detection engine (§20.3 `internal`). */
export class DetectionError extends PlatformError {
  readonly category: ErrorCategory = 'internal';
}

/** A single detector threw or timed out during execution (§20.3 `internal`). */
export class DetectorFailure extends PlatformError {
  readonly category: ErrorCategory = 'internal';
}

/** A candidate failed validation and was rejected (§20.3 `validation`). */
export class ValidationFailure extends PlatformError {
  readonly category: ErrorCategory = 'validation';
}

/** A candidate's media type/protocol is not supported (§20.3 `validation`; §6). */
export class UnsupportedMedia extends PlatformError {
  readonly category: ErrorCategory = 'validation';
}

/** A candidate duplicates one already accepted this cycle (§20.3 `validation`). */
export class DuplicateMedia extends PlatformError {
  readonly category: ErrorCategory = 'validation';
}

// --- Phase 4 (advanced detection) ---------------------------------------------

/** A manifest URL is malformed or uses an unsupported protocol (§5.5, §20.3). */
export class ManifestError extends PlatformError {
  readonly category: ErrorCategory = 'validation';
}

/** A MediaSource/EME capability could not be handled within the model (§5.4, §6). */
export class MediaSourceError extends PlatformError {
  readonly category: ErrorCategory = 'capability';
}

/** Correlation across detector results failed (§20.3 `internal`). */
export class CorrelationError extends PlatformError {
  readonly category: ErrorCategory = 'internal';
}

/** Metadata enrichment failed (§20.3 `internal`). */
export class MetadataError extends PlatformError {
  readonly category: ErrorCategory = 'internal';
}

/** A network observation could not be processed (§12.6, §20.3 `network`). */
export class NetworkObservationError extends PlatformError {
  readonly category: ErrorCategory = 'network';
}
