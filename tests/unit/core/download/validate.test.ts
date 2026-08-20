import { describe, expect, it } from 'vitest';
import type { DeliveryType } from '@shared/types';
import { DownloadValidationError } from '@core/download/errors';
import { FORBIDDEN_DELIVERY, STREAM_DELIVERY, validateDownloadable } from '@core/download/validate';
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

  it('refuses blob/MediaSource delivery whether or not assembly exists', () => {
    // Neither has addressable bytes to fetch, so no amount of assembly helps (§5.4).
    for (const delivery of ['blob', 'media-source'] as const) {
      expect(FORBIDDEN_DELIVERY.has(delivery satisfies DeliveryType)).toBe(true);
      expect(validateDownloadable(mediaItem({ delivery })).ok).toBe(false);
      expect(validateDownloadable(mediaItem({ delivery }), { allowStreams: true }).ok).toBe(false);
    }
  });

  it('refuses HLS/DASH unless the caller can assemble them (§10.6)', () => {
    for (const delivery of ['hls', 'dash'] as const) {
      expect(STREAM_DELIVERY.has(delivery satisfies DeliveryType)).toBe(true);
      // Default: no assembly, so a manifest is refused rather than saved as text.
      const refused = validateDownloadable(mediaItem({ delivery }));
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error.code).toBe('download-manifest-url');
      }
      expect(validateDownloadable(mediaItem({ delivery }), { allowStreams: true }).ok).toBe(true);
    }
  });

  it('keeps refusing a stream that was classified unsupported (DRM), even with assembly', () => {
    const result = validateDownloadable(
      mediaItem({ delivery: 'hls', status: 'unsupported', unsupportedReason: 'DRM' }),
      { allowStreams: true },
    );
    expect(result.ok).toBe(false);
  });

  it('refuses non-http(s) URLs (blob:, etc.)', () => {
    expect(
      validateDownloadable(mediaItem({ url: 'blob:https://x.com/y', delivery: 'html5' })).ok,
    ).toBe(false);
    expect(
      validateDownloadable(mediaItem({ url: 'ftp://x.com/a.mp4', delivery: 'direct' })).ok,
    ).toBe(false);
  });

  it('recognises a manifest by URL even when delivery is unset (§6)', () => {
    // The delivery gate keys on the OPTIONAL delivery field; a manifest URL with
    // delivery undefined must be treated as a stream by its extension alone —
    // refused without assembly, allowed with it.
    for (const url of [
      'https://cdn.example.com/live/master.m3u8',
      'https://cdn.example.com/live/index.m3u',
      'https://cdn.example.com/vod/manifest.mpd',
    ]) {
      expect(validateDownloadable(mediaItem({ url, delivery: undefined })).ok).toBe(false);
      expect(
        validateDownloadable(mediaItem({ url, delivery: undefined }), { allowStreams: true }).ok,
      ).toBe(true);
    }
  });
});
