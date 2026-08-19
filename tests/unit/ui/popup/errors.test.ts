import { describe, expect, it } from 'vitest';
import type { AppError, ErrorCategory } from '@shared/result';
import { MessagingError, PermissionError } from '@shared/result/errors';
import { createTranslator, describeError, toAppError } from '@ui/popup';

const t = createTranslator();

function error(category: ErrorCategory, retryable = false): AppError {
  return { category, code: `${category}-1`, messageKey: 'x', retryable };
}

describe('ui/popup error presentation', () => {
  it('passes a well-formed AppError through, dropping local-only diagnostics', () => {
    const source: AppError = {
      category: 'permission',
      code: 'download-permission-denied',
      messageKey: 'error.permission.downloads',
      retryable: false,
      cause: new Error('secret'),
      context: { permission: 'downloads' },
    };
    expect(toAppError(source)).toEqual({
      category: 'permission',
      code: 'download-permission-denied',
      messageKey: 'error.permission.downloads',
      retryable: false,
    });
  });

  it('accepts the platform error classes, which implement the taxonomy', () => {
    expect(toAppError(new PermissionError('nope', { code: 'p', messageKey: 'k' })).category).toBe(
      'permission',
    );
    expect(
      toAppError(new MessagingError('boom', { code: 'm', messageKey: 'k', retryable: true }))
        .retryable,
    ).toBe(true);
  });

  it('turns anything else into an internal error rather than losing it', () => {
    for (const value of [new Error('raw'), 'string', undefined, null, 42, { category: 'nope' }]) {
      expect(toAppError(value)).toEqual({
        category: 'internal',
        code: 'popup-unexpected',
        messageKey: 'error.internal',
        retryable: true,
      });
    }
  });

  it('describes every category in plain language', () => {
    const categories: readonly ErrorCategory[] = [
      'network',
      'http',
      'drm',
      'validation',
      'storage',
      'permission',
      'capability',
      'internal',
    ];
    for (const category of categories) {
      const described = describeError(error(category), t);
      expect(described.title).toBe('Something went wrong');
      expect(described.detail.length).toBeGreaterThan(0);
      expect(described.detail).not.toContain('undefined');
    }
  });

  it('carries the retryability the contract declared', () => {
    expect(describeError(error('network', true), t).retryable).toBe(true);
    expect(describeError(error('drm', false), t).retryable).toBe(false);
  });

  it('never leaks an internal code into user-facing text', () => {
    const described = describeError(
      { category: 'http', code: 'http-403', messageKey: 'k', retryable: false },
      t,
    );
    expect(`${described.title} ${described.detail}`).not.toContain('http-403');
  });
});
