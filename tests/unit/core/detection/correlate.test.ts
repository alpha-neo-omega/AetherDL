import { describe, expect, it } from 'vitest';
import { createCorrelator } from '@core/detection/dedupe/correlate';
import type { MediaItem } from '@shared/types';

function item(props: Partial<MediaItem> & Pick<MediaItem, 'url' | 'detectedBy'>): MediaItem {
  return {
    id: props.url,
    kind: 'video',
    status: 'supported',
    title: 't',
    originHost: 'x.com',
    score: 0.4,
    discoveredAt: 0,
    ...props,
  };
}

describe('correlation engine', () => {
  it('merges corroborating candidates and records the corroborating detectors', () => {
    const correlator = createCorrelator({
      priorityOf: (id) => (id === 'html5-video' ? 90 : id === 'network-media' ? 75 : 0),
    });
    const html5 = item({
      url: 'https://x.com/a.mp4',
      container: 'mp4',
      detectedBy: 'html5-video',
      score: 0.5,
      width: 1920,
      height: 1080,
    });
    const network = item({
      url: 'https://x.com/a.mp4',
      container: 'mp4',
      detectedBy: 'network-media',
      score: 0.6,
      sizeBytes: 1000,
    });

    const result = correlator.dedupe([network, html5]);
    expect(result).toHaveLength(1);
    // Higher-priority html5-video is the base; network fills the size gap.
    expect(result[0]).toMatchObject({ detectedBy: 'html5-video', width: 1920, sizeBytes: 1000 });
    expect(result[0]?.metadata?.['corroboratedBy']).toEqual(['network-media', 'html5-video']);
  });

  it('raises confidence by an exact bounded increment when detectors corroborate', () => {
    const correlator = createCorrelator();
    const single = correlator.dedupe([
      item({ url: 'https://x.com/solo.mp4', container: 'mp4', detectedBy: 'a', score: 0.5 }),
    ]);
    expect(single[0]?.score).toBe(0.5);

    const doubled = correlator.dedupe([
      item({ url: 'https://x.com/x.mp4', container: 'mp4', detectedBy: 'a', score: 0.5 }),
      item({ url: 'https://x.com/x.mp4', container: 'mp4', detectedBy: 'b', score: 0.5 }),
    ]);
    // base 0.5 + 1 extra detector * 0.05 bonus = 0.55 (exact).
    expect(doubled[0]?.score).toBe(0.55);
  });

  it('caps the corroboration bonus (MAX_CORROBORATION) and clamps to [0,1]', () => {
    const correlator = createCorrelator();
    const many = ['a', 'b', 'c', 'd', 'e'].map((id) =>
      item({ url: 'https://x.com/y.mp4', container: 'mp4', detectedBy: id, score: 0.5 }),
    );
    const result = correlator.dedupe(many);
    expect(result).toHaveLength(1);
    // 5 detectors → min(4, 3) * 0.05 = 0.15 bonus; 0.5 + 0.15 = 0.65 (cap applied).
    expect(result[0]?.score).toBe(0.65);
    expect(result[0]?.metadata?.['corroboratedBy']).toHaveLength(5);
  });

  it('never upgrades an unsupported (DRM/blob) refusal to supported on merge (§6)', () => {
    const correlator = createCorrelator({ priorityOf: (id) => (id === 'html5-video' ? 90 : 45) });
    const supported = item({
      url: 'https://x.com/m.mp4',
      container: 'mp4',
      detectedBy: 'html5-video',
      status: 'supported',
      score: 0.6,
    });
    const refused = item({
      url: 'https://x.com/m.mp4',
      container: 'mp4',
      detectedBy: 'media-source',
      status: 'unsupported',
      unsupportedReason: 'Encrypted (DRM/EME) media is not supported.',
      score: 0.3,
    });
    const result = correlator.dedupe([supported, refused]);
    expect(result).toHaveLength(1);
    // html5-video wins the field merge (priority 90) but the refusal is sticky.
    expect(result[0]?.status).toBe('unsupported');
    expect(result[0]?.unsupportedReason).toMatch(/Encrypted|DRM/i);
  });

  it('does not corroborate when the same detector reports twice', () => {
    const correlator = createCorrelator();
    const result = correlator.dedupe([
      item({ url: 'https://x.com/x.mp4', container: 'mp4', detectedBy: 'a', score: 0.5 }),
      item({ url: 'https://x.com/x.mp4', container: 'mp4', detectedBy: 'a', score: 0.5 }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.score).toBe(0.5);
    expect(result[0]?.metadata?.['corroboratedBy']).toBeUndefined();
  });

  it('keeps distinct media separate', () => {
    const correlator = createCorrelator();
    const result = correlator.dedupe([
      item({ url: 'https://x.com/a.mp4', container: 'mp4', detectedBy: 'a' }),
      item({ url: 'https://x.com/b.mp4', container: 'mp4', detectedBy: 'a' }),
    ]);
    expect(result).toHaveLength(2);
  });
});
