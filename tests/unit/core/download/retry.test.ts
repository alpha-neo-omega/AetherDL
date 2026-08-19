import { describe, expect, it } from 'vitest';
import type { AppError } from '@shared/result';
import { createRetryPolicy } from '@core/download/retry/retry';

function error(retryable: boolean): AppError {
  return { category: 'http', code: 'c', messageKey: 'k', retryable };
}

describe('retry policy', () => {
  it('retries retryable errors with deterministic exponential backoff + jitter', () => {
    const policy = createRetryPolicy({ maxAttempts: 3, baseDelayMs: 500, random: () => 0.5 });
    // attempt 0: 500 + 0.5*500*0.5 = 625
    expect(policy.shouldRetry(error(true), 0)).toEqual({ retry: true, delayMs: 625 });
    // attempt 1: 1000 + 0.5*1000*0.5 = 1250
    expect(policy.shouldRetry(error(true), 1)).toEqual({ retry: true, delayMs: 1250 });
    // attempt 2: 2000 + 0.5*2000*0.5 = 2500
    expect(policy.shouldRetry(error(true), 2)).toEqual({ retry: true, delayMs: 2500 });
  });

  it('does not retry once attempts reach the limit', () => {
    const policy = createRetryPolicy({ maxAttempts: 3, random: () => 0 });
    expect(policy.shouldRetry(error(true), 3)).toEqual({ retry: false, delayMs: 0 });
  });

  it('never retries non-retryable errors (validation/DRM/permission)', () => {
    const policy = createRetryPolicy({ maxAttempts: 5, random: () => 0 });
    expect(policy.shouldRetry(error(false), 0)).toEqual({ retry: false, delayMs: 0 });
  });

  it('caps backoff at maxDelayMs', () => {
    const policy = createRetryPolicy({
      maxAttempts: 20,
      baseDelayMs: 1000,
      maxDelayMs: 3000,
      random: () => 0,
    });
    expect(policy.shouldRetry(error(true), 10).delayMs).toBe(3000);
  });
});
