/**
 * Module: core/download/retry
 * Purpose: Retry-policy contract — exponential backoff with jitter
 *          (PROJECT_BIBLE.md §10.4). Only retryable errors are retried (§20.3).
 * Restrictions: Domain layer — deterministic given injected randomness (§16.1).
 * Dependencies: shared/result.
 * Public API: RetryDecision, RetryPolicy.
 */
import type { AppError } from '@shared/result';

export interface RetryDecision {
  readonly retry: boolean;
  readonly delayMs: number;
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  shouldRetry(error: AppError, attempt: number): RetryDecision;
}
