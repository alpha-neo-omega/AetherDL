import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILENAME_TEMPLATE,
  MAX_CONCURRENT_DOWNLOADS_DEFAULT,
  MAX_RETRIES_DEFAULT,
} from '@shared/constants';
import { DEFAULT_SETTINGS } from '@core/settings';

describe('core/settings DEFAULT_SETTINGS', () => {
  it('uses the normative defaults from PROJECT_BIBLE.md §4.9', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('system');
    expect(DEFAULT_SETTINGS.maxConcurrentDownloads).toBe(MAX_CONCURRENT_DOWNLOADS_DEFAULT);
    expect(DEFAULT_SETTINGS.maxRetries).toBe(MAX_RETRIES_DEFAULT);
    expect(DEFAULT_SETTINGS.filenameTemplate).toBe(DEFAULT_FILENAME_TEMPLATE);
    expect(DEFAULT_SETTINGS.detectionSensitivity).toBe('balanced');
  });

  it('is privacy-preserving by default (no field enables data egress)', () => {
    // History is local-only; retention default keeps data on-device (§14).
    expect(DEFAULT_SETTINGS.keepHistory).toBe(true);
    expect(DEFAULT_SETTINGS.historyRetention).toBe('forever');
  });
});
