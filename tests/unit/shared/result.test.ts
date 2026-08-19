import { describe, expect, it } from 'vitest';
import { err, isErr, isOk, ok, type AppError } from '@shared/result';

describe('shared/result', () => {
  it('constructs a success result', () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    expect(isOk(result)).toBe(true);
    expect(isErr(result)).toBe(false);
    if (isOk(result)) {
      expect(result.value).toBe(42);
    }
  });

  it('constructs a failure result carrying an AppError', () => {
    const error: AppError = {
      category: 'network',
      code: 'network-timeout',
      messageKey: 'error.network.timeout',
      retryable: true,
    };
    const result = err(error);
    expect(result.ok).toBe(false);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.category).toBe('network');
      expect(result.error.retryable).toBe(true);
    }
  });
});
