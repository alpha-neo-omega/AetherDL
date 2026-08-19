import { describe, expect, it } from 'vitest';
import type { DeliveryType } from '@shared/types';
import { DownloadValidationError } from '@core/download/errors';
import { FORBIDDEN_DELIVERY, validateDownloadable } from '@core/download/validate';
import { mediaItem } from './_fixtures';

describe('download validation', () => {
  it('accepts supported progressive/direct/html5 http(s) media', () => {
    for (const delivery of ['progressive', 'direct', 'html5'] as const) {
      expect(validateDownloadable(mediaItem({ delivery })).ok).toBe(true);
    }
    // No delivery hint but supported + http → allowed (a plain direct file).
    expect(validateDownloadable(mediaItem({ delivery: undefined })).ok).toBe(true);
  });

  it('refuses unsupported (DRM/blob/MediaSource classified upstream, §6)', () => {
    const result = validateDownloadable(
      mediaItem({ status: 'unsupported', unsupportedReason: 'DRM' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(DownloadValidationError);
    }
  });

  it('refuses forbidden delivery types (streams/blob/MSE)', () => {
    for (const delivery of ['hls', 'dash', 'blob', 'media-source'] as const) {
      expect(FORBIDDEN_DELIVERY.has(delivery satisfies DeliveryType)).toBe(true);
      expect(validateDownloadable(mediaItem({ delivery })).ok).toBe(false);
    }
  });

  it('refuses non-http(s) URLs (blob:, etc.)', () => {
    expect(
      validateDownloadable(mediaItem({ url: 'blob:https://x.com/y', delivery: 'html5' })).ok,
    ).toBe(false);
    expect(
      validateDownloadable(mediaItem({ url: 'ftp://x.com/a.mp4', delivery: 'direct' })).ok,
    ).toBe(false);
  });

  it('refuses manifest URLs (HLS/DASH) even when delivery is unset (§6)', () => {
    // The forbidden-delivery gate keys on the OPTIONAL delivery field; a manifest
    // URL with delivery undefined must still be refused by URL extension.
    for (const url of [
      'https://cdn.example.com/live/master.m3u8',
      'https://cdn.example.com/live/index.m3u',
      'https://cdn.example.com/vod/manifest.mpd',
    ]) {
      expect(validateDownloadable(mediaItem({ url, delivery: undefined })).ok).toBe(false);
    }
  });
});
