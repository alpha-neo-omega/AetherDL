import { describe, expect, it } from 'vitest';
import { ManifestError, UnsupportedMedia, ValidationFailure } from '@core/detection/errors';
import type { RawCandidate } from '@core/detection/pipeline';
import { validateCandidate } from '@core/detection/pipeline/validate';

function candidate(props: Partial<RawCandidate> & Pick<RawCandidate, 'url'>): RawCandidate {
  return { kind: 'video', detectedBy: 'test', ...props };
}

describe('detection validation', () => {
  it('accepts a valid http(s) URL with supported extension', () => {
    const result = validateCandidate(candidate({ url: 'https://x.com/a.mp4', container: 'mp4' }));
    expect(result.ok).toBe(true);
  });

  it('accepts when a supported MIME is present even without an extension', () => {
    const result = validateCandidate(
      candidate({ url: 'https://x.com/stream', mimeType: 'video/mp4' }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an empty URL', () => {
    const result = validateCandidate(candidate({ url: '   ' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ValidationFailure);
    }
  });

  it('rejects a malformed URL', () => {
    const result = validateCandidate(candidate({ url: 'ht!tp://bad url' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ValidationFailure);
    }
  });

  it('rejects unsupported protocols', () => {
    for (const url of ['ftp://x.com/a.mp4', 'javascript:alert(1)', 'file:///etc/passwd']) {
      const result = validateCandidate(candidate({ url }));
      expect(result.ok).toBe(false);
    }
  });

  it('rejects unsupported media types', () => {
    const result = validateCandidate(candidate({ url: 'https://x.com/a.pdf' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(UnsupportedMedia);
    }
  });

  it('accepts a blob with a known kind but rejects unclassifiable blobs', () => {
    expect(validateCandidate(candidate({ url: 'blob:https://x.com/v', kind: 'video' })).ok).toBe(
      true,
    );
    const bad = validateCandidate(candidate({ url: 'blob:https://x.com/v', kind: 'stream' }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toBeInstanceOf(UnsupportedMedia);
    }
  });

  it('accepts a blob classified by a supported MIME even when kind is unusual', () => {
    const result = validateCandidate(
      candidate({ url: 'blob:https://x.com/v', kind: 'stream', mimeType: 'video/mp4' }),
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a well-formed http(s) HLS/DASH manifest (recognition, §5.5)', () => {
    expect(
      validateCandidate(candidate({ url: 'https://x.com/m.m3u8', kind: 'stream', delivery: 'hls' }))
        .ok,
    ).toBe(true);
    expect(
      validateCandidate(candidate({ url: 'https://x.com/m.mpd', kind: 'stream', delivery: 'dash' }))
        .ok,
    ).toBe(true);
  });

  it('rejects a malformed manifest URL with ManifestError', () => {
    const result = validateCandidate(
      candidate({ url: 'ht!tp://bad/m.m3u8', kind: 'stream', delivery: 'hls' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ManifestError);
    }
  });

  it('rejects a manifest on an unsupported protocol with ManifestError', () => {
    const result = validateCandidate(
      candidate({ url: 'ftp://x.com/m.m3u8', kind: 'stream', delivery: 'hls' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ManifestError);
    }
  });
});
