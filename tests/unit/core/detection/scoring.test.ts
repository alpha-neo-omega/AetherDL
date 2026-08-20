import { describe, expect, it } from 'vitest';
import { UNTITLED_MEDIA_TITLE } from '@shared/constants';
import { clamp01, createScorer } from '@core/detection/scoring/scoring';
import type { MediaItem } from '@shared/types';

function item(props: Partial<MediaItem> & Pick<MediaItem, 'detectedBy'>): MediaItem {
  return {
    id: 'id',
    kind: 'video',
    status: 'supported',
    title: 't',
    url: 'https://x.com/a.mp4',
    originHost: 'x.com',
    score: 0,
    discoveredAt: 0,
    ...props,
  };
}

describe('detection scoring', () => {
  const scorer = createScorer();

  it('ranks unambiguous sources above best-effort blob media', () => {
    const direct = scorer.score(item({ detectedBy: 'direct-url' }));
    const blob = scorer.score(item({ detectedBy: 'blob-media' }));
    expect(direct).toBeGreaterThan(blob);
  });

  it('rewards metadata completeness', () => {
    const bare = scorer.score(item({ detectedBy: 'html5-video' }));
    const rich = scorer.score(
      item({
        detectedBy: 'html5-video',
        mimeType: 'video/mp4',
        width: 1920,
        height: 1080,
        durationSec: 60,
        title: 'x',
        sizeBytes: 1000,
      }),
    );
    expect(rich).toBeGreaterThan(bare);
  });

  it('is deterministic and clamped to [0,1]', () => {
    const rich = item({
      detectedBy: 'html5-video',
      mimeType: 'video/mp4',
      width: 3840,
      height: 2160,
      durationSec: 60,
      title: 'x',
      sizeBytes: 1,
    });
    const first = scorer.score(rich);
    const second = scorer.score(rich);
    expect(first).toBe(second);
    expect(first).toBeLessThanOrEqual(1);
    expect(first).toBeGreaterThanOrEqual(0);
  });

  it('falls back to a base weight for unknown detectors', () => {
    expect(scorer.score(item({ detectedBy: 'unknown-detector' }))).toBeGreaterThan(0);
  });

  it('clamp01 bounds values into [0,1]', () => {
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(0.42)).toBe(0.42);
  });

  it('clamps a pathologically negative signal to 0', () => {
    expect(scorer.score(item({ detectedBy: 'blob-media', width: 1, height: -1_000_000 }))).toBe(0);
  });
});

describe('scoring: the title term must actually distinguish (§9.7)', () => {
  it('rewards a real title and not the placeholder every unnamed item carries', () => {
    // Regression: `title` is a required field, so rewarding its mere presence added
    // the same constant to every score and ranked nothing.
    const scorer = createScorer();
    const base = item({ detectedBy: 'html5-video' });

    const named = scorer.score({ ...base, title: 'Episode 4 — The Reveal' });
    const unnamed = scorer.score({ ...base, title: UNTITLED_MEDIA_TITLE });
    const empty = scorer.score({ ...base, title: '' });

    expect(named).toBeGreaterThan(unnamed);
    expect(empty).toBe(unnamed);
  });
});
