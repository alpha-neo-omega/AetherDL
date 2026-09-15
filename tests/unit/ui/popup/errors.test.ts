import { describe, expect, it } from 'vitest';
import type { AppError, ErrorCategory } from '@shared/result';
import { MessagingError, PermissionError } from '@shared/result/errors';
import { createTranslator, describeError, toAppError, EN_MESSAGES } from '@ui/popup';

const t = createTranslator();

function error(category: ErrorCategory, retryable = false): AppError {
  return { category, code: `${category}-1`, messageKey: 'x', retryable };
}

describe('ui/popup error presentation', () => {
  it('drops the cause but keeps the context', () => {
    // `cause` carries stack traces and whatever an underlying library put in its
    // message: local-only, and it never reaches the user (§20.5). `context` is the
    // opposite — the taxonomy defines it as safe, non-PII data, and it is what lets a
    // failure say WHICH host refused and what it answered instead of "check your
    // network". Dropping it too is what made every transport failure read the same.
    const source: AppError = {
      category: 'permission',
      code: 'download-permission-denied',
      messageKey: 'error.permission.downloads',
      retryable: false,
      cause: new Error('secret'),
      context: { permission: 'downloads' },
    };

    const normalized = toAppError(source);

    expect(normalized).toEqual({
      category: 'permission',
      code: 'download-permission-denied',
      messageKey: 'error.permission.downloads',
      retryable: false,
      context: { permission: 'downloads' },
    });
    expect(normalized.cause).toBeUndefined();
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

describe('a failure that knows which host and what it answered (§20.5)', () => {
  it('says what the host answered instead of blaming the network', () => {
    // "Connection problem. Check your network and try again." for a 403 sends someone
    // to fix something that is not broken.
    const detail = describeError(
      {
        category: 'network',
        code: 'stream-manifest-fetch-failed',
        messageKey: 'error.network',
        retryable: false,
        context: { host: 'cdn1020.example.org', status: 'http-403' },
      },
      t,
    ).detail;

    expect(detail).toContain('cdn1020.example.org');
    expect(detail).toContain('http-403');
    expect(detail).not.toContain('Check your network');
  });

  it('says the link may have expired when the answer could not be read at all', () => {
    // A host with no CORS header hides even its own refusal: the browser reports a
    // bare failure. Naming the host and the likeliest cause beats "check your network".
    const detail = describeError(
      {
        category: 'network',
        code: 'stream-manifest-fetch-failed',
        messageKey: 'error.network',
        retryable: true,
        context: { host: 'cdn1020.example.org' },
      },
      t,
    ).detail;

    expect(detail).toContain('cdn1020.example.org');
    expect(detail).toContain('reload');
  });

  it('says a host is not permitted rather than guessing at expiry', () => {
    const detail = describeError(
      {
        category: 'permission',
        code: 'stream-host-not-permitted',
        messageKey: 'error.permission.host',
        retryable: false,
        context: { host: 'cdn1020.example.org', origin: 'https://cdn1020.example.org/*' },
      },
      t,
    ).detail;

    expect(detail).toContain('not allowed to read cdn1020.example.org');
  });

  it('falls back to the category sentence when nothing named a host', () => {
    const detail = describeError(
      { category: 'network', code: 'http-timeout', messageKey: 'error.network', retryable: true },
      t,
    ).detail;

    expect(detail).toBe(EN_MESSAGES['error.network']);
  });

  it('keeps the context when normalizing a rejection', () => {
    const normalized = toAppError({
      category: 'network',
      code: 'stream-manifest-fetch-failed',
      messageKey: 'error.network',
      retryable: false,
      context: { host: 'cdn.example', status: 'http-403' },
    });

    expect(normalized.context).toStrictEqual({ host: 'cdn.example', status: 'http-403' });
  });
});
