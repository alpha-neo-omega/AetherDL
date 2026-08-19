import { describe, expect, it } from 'vitest';
import {
  DownloadError,
  MessagingError,
  PermissionError,
  PlatformError,
  RuntimeError,
  StorageError,
  TabError,
  ValidationError,
} from '@shared/result/errors';

describe('shared/result platform errors', () => {
  it('are Error and PlatformError instances with the right category', () => {
    const error = new StorageError('nope', { code: 'x', messageKey: 'k' });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(PlatformError);
    expect(error.category).toBe('storage');
    expect(error.name).toBe('StorageError');
    expect(error.retryable).toBe(false);
  });

  it('maps each subclass to its taxonomy category (§20.3)', () => {
    expect(new PermissionError('', { code: 'a', messageKey: 'k' }).category).toBe('permission');
    expect(new MessagingError('', { code: 'a', messageKey: 'k' }).category).toBe('internal');
    expect(new RuntimeError('', { code: 'a', messageKey: 'k' }).category).toBe('internal');
    expect(new DownloadError('', { code: 'a', messageKey: 'k' }).category).toBe('http');
    expect(new TabError('', { code: 'a', messageKey: 'k' }).category).toBe('capability');
    expect(new ValidationError('', { code: 'a', messageKey: 'k' }).category).toBe('validation');
  });

  it('toAppError projects the AppError shape, including optional fields', () => {
    const bare = new DownloadError('f', { code: 'c', messageKey: 'k', retryable: true });
    expect(bare.toAppError()).toEqual({
      category: 'http',
      code: 'c',
      messageKey: 'k',
      retryable: true,
    });

    const cause = new Error('root');
    const rich = new StorageError('f', {
      code: 'c',
      messageKey: 'k',
      cause,
      context: { area: 'local' },
    });
    const app = rich.toAppError();
    expect(app.cause).toBe(cause);
    expect(app.context).toEqual({ area: 'local' });
  });
});
