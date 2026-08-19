import { describe, expect, it } from 'vitest';
import {
  CorrelationError,
  DetectionError,
  DetectorFailure,
  DuplicateMedia,
  ManifestError,
  MediaSourceError,
  MetadataError,
  NetworkObservationError,
  UnsupportedMedia,
  ValidationFailure,
} from '@core/detection/errors';
import { PlatformError } from '@shared/result/errors';

describe('detection errors', () => {
  it('extend PlatformError and map to their taxonomy category (§20.3)', () => {
    const cases = [
      { error: new DetectionError('', { code: 'a', messageKey: 'k' }), category: 'internal' },
      { error: new DetectorFailure('', { code: 'a', messageKey: 'k' }), category: 'internal' },
      { error: new ValidationFailure('', { code: 'a', messageKey: 'k' }), category: 'validation' },
      { error: new UnsupportedMedia('', { code: 'a', messageKey: 'k' }), category: 'validation' },
      { error: new DuplicateMedia('', { code: 'a', messageKey: 'k' }), category: 'validation' },
      { error: new ManifestError('', { code: 'a', messageKey: 'k' }), category: 'validation' },
      { error: new MediaSourceError('', { code: 'a', messageKey: 'k' }), category: 'capability' },
      { error: new CorrelationError('', { code: 'a', messageKey: 'k' }), category: 'internal' },
      { error: new MetadataError('', { code: 'a', messageKey: 'k' }), category: 'internal' },
      {
        error: new NetworkObservationError('', { code: 'a', messageKey: 'k' }),
        category: 'network',
      },
    ] as const;
    for (const { error, category } of cases) {
      expect(error).toBeInstanceOf(PlatformError);
      expect(error.category).toBe(category);
      expect(error.toAppError().code).toBe('a');
    }
  });
});
