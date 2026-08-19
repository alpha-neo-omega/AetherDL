/**
 * Module: core/download/retry (implementation)
 * Purpose: Exponential-backoff-with-jitter retry policy (PROJECT_BIBLE.md §10.4).
 *          Only retryable errors are retried, up to a bounded attempt count.
 * Restrictions: Domain layer — deterministic given the injected RNG (§16.1). Never
 *          retries non-retryable errors (validation/DRM/permission/4xx, §20.3).
 * Public API: RetryPolicyOptions, createRetryPolicy.
 */
import type { AppError } from '@shared/result';
import type { RetryDecision, RetryPolicy } from '@core/download/retry';

export interface RetryPolicyOptions {
  /** Maximum attempts before permanent failure (§4.9 default 3). */
  readonly maxAttempts: number;
  /** Base delay in ms for attempt 0. */
  readonly baseDelayMs?: number;
  /** Upper bound on backoff delay in ms. */
  readonly maxDelayMs?: number;
  /** Injectable RNG in [0,1) for jitter (default Math.random). */
  readonly random?: () => number;
}

export function createRetryPolicy(options: RetryPolicyOptions): RetryPolicy {
  const maxAttempts = Math.max(0, Math.floor(options.maxAttempts));
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const random = options.random ?? ((): number => Math.random());

  return {
    maxAttempts,
    shouldRetry(error: AppError, attempt: number): RetryDecision {
      // Non-retryable (validation/DRM/permission/4xx) or exhausted → give up.
      if (!error.retryable || attempt >= maxAttempts) {
        return { retry: false, delayMs: 0 };
      }
      const backoff = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      // Full jitter up to 50% of the backoff to de-synchronize retries.
      const jitter = random() * backoff * 0.5;
      return { retry: true, delayMs: Math.round(backoff + jitter) };
    },
  };
}
