import { describe, expect, it } from 'vitest';
import {
  DownloadValidationError,
  FilenameError,
  PermissionDeniedError,
  QueueError,
  RetryError,
  SchedulerError,
} from '@core/download/errors';
import { PlatformError } from '@shared/result/errors';

describe('download errors', () => {
  it('extend PlatformError and map to their taxonomy category (§20.3)', () => {
    const cases = [
      {
        error: new DownloadValidationError('', { code: 'a', messageKey: 'k' }),
        category: 'validation',
      },
      { error: new QueueError('', { code: 'a', messageKey: 'k' }), category: 'internal' },
      { error: new RetryError('', { code: 'a', messageKey: 'k' }), category: 'internal' },
      { error: new FilenameError('', { code: 'a', messageKey: 'k' }), category: 'validation' },
      { error: new SchedulerError('', { code: 'a', messageKey: 'k' }), category: 'internal' },
      {
        error: new PermissionDeniedError('', { code: 'a', messageKey: 'k' }),
        category: 'permission',
      },
    ] as const;
    for (const { error, category } of cases) {
      expect(error).toBeInstanceOf(PlatformError);
      expect(error.category).toBe(category);
      expect(error.toAppError().code).toBe('a');
    }
  });
});
