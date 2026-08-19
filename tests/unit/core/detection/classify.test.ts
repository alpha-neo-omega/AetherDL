import { describe, expect, it } from 'vitest';
import { classifyDelivery } from '@core/detection/metadata/classify';
import type { RawCandidate } from '@core/detection/pipeline';

function candidate(props: Partial<RawCandidate> & Pick<RawCandidate, 'detectedBy'>): RawCandidate {
  return { url: 'https://x.com/a', kind: 'video', ...props };
}

describe('delivery classification', () => {
  it('honors an explicit delivery hint', () => {
    expect(classifyDelivery(candidate({ detectedBy: 'x', delivery: 'hls' }))).toBe('hls');
  });

  it('classifies by container when no hint is present', () => {
    expect(classifyDelivery(candidate({ detectedBy: 'x', container: 'm3u8' }))).toBe('hls');
    expect(classifyDelivery(candidate({ detectedBy: 'x', container: 'mpd' }))).toBe('dash');
  });

  it('classifies blobs and by detector id', () => {
    expect(classifyDelivery(candidate({ detectedBy: 'x', isBlob: true }))).toBe('blob');
    expect(classifyDelivery(candidate({ detectedBy: 'html5-video' }))).toBe('html5');
    expect(classifyDelivery(candidate({ detectedBy: 'html5-audio' }))).toBe('html5');
    expect(classifyDelivery(candidate({ detectedBy: 'direct-url' }))).toBe('direct');
    expect(classifyDelivery(candidate({ detectedBy: 'network-media' }))).toBe('progressive');
    expect(classifyDelivery(candidate({ detectedBy: 'blob-media' }))).toBe('blob');
    expect(classifyDelivery(candidate({ detectedBy: 'media-source' }))).toBe('media-source');
    expect(classifyDelivery(candidate({ detectedBy: 'unknown' }))).toBe('direct');
  });
});
