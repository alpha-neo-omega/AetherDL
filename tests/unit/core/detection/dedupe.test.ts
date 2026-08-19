import { describe, expect, it } from 'vitest';
import { computeIdentityKey, createDeduplicator } from '@core/detection/dedupe/dedupe';
import type { MediaItem } from '@shared/types';

function item(props: Partial<MediaItem> & Pick<MediaItem, 'url'>): MediaItem {
  return {
    id: props.url,
    kind: 'video',
    status: 'supported',
    title: 't',
    originHost: 'x.com',
    detectedBy: 'd',
    score: 0,
    discoveredAt: 0,
    ...props,
  };
}

describe('detection dedupe', () => {
  it('computes a stable identity key across URL variants that normalize equal', () => {
    const a = computeIdentityKey({
      url: 'https://X.com:443/a.mp4#top',
      container: 'mp4',
      kind: 'video',
    });
    const b = computeIdentityKey({ url: 'https://x.com/a.mp4', container: 'mp4', kind: 'video' });
    expect(a).toBe(b);
  });

  it('identity ignores resolution so a URL seen with and without dims dedupes (§4.6)', () => {
    const dedupe = createDeduplicator();
    const withDims = item({
      url: 'https://x.com/a.mp4',
      container: 'mp4',
      width: 1920,
      height: 1080,
      score: 0.8,
    });
    const withoutDims = item({
      url: 'https://x.com/a.mp4',
      container: 'mp4',
      score: 0.5,
      detectedBy: 'direct-url',
    });
    const result = dedupe.dedupe([withDims, withoutDims]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ width: 1920, height: 1080 });
  });

  it('merges duplicates by score when detector priorities are equal', () => {
    const dedupe = createDeduplicator();
    const low = item({
      url: 'https://x.com/a.mp4',
      container: 'mp4',
      score: 0.3,
      mimeType: 'video/mp4',
    });
    const high = item({
      url: 'https://x.com/a.mp4',
      container: 'mp4',
      score: 0.8,
      title: 'High',
      detectedBy: 'direct-url',
    });
    const result = dedupe.dedupe([low, high]);
    expect(result[0]).toMatchObject({
      score: 0.8,
      detectedBy: 'direct-url',
      title: 'High',
      mimeType: 'video/mp4',
    });
  });

  it('chooses the merge base by detector priority, not score (§9.4/§9.5)', () => {
    const priorityOf = (detectedBy: string): number =>
      detectedBy === 'html5-audio' ? 85 : detectedBy === 'direct-url' ? 80 : 0;
    const dedupe = createDeduplicator(priorityOf);
    const audio = item({
      url: 'https://x.com/s.mp3',
      container: 'mp3',
      kind: 'audio',
      score: 0.45,
      detectedBy: 'html5-audio',
      title: 'My Song',
    });
    const direct = item({
      url: 'https://x.com/s.mp3',
      container: 'mp3',
      kind: 'audio',
      score: 0.5,
      detectedBy: 'direct-url',
      title: 's.mp3',
    });
    // direct-url scores higher but html5-audio has higher priority → it wins the base.
    expect(dedupe.dedupe([direct, audio])[0]).toMatchObject({
      detectedBy: 'html5-audio',
      title: 'My Song',
    });
    expect(dedupe.dedupe([audio, direct])[0]).toMatchObject({
      detectedBy: 'html5-audio',
      title: 'My Song',
    });
  });

  it('keeps genuinely distinct items', () => {
    const dedupe = createDeduplicator();
    const result = dedupe.dedupe([
      item({ url: 'https://x.com/a.mp4', container: 'mp4' }),
      item({ url: 'https://x.com/b.webm', container: 'webm' }),
    ]);
    expect(result).toHaveLength(2);
  });

  it('falls back to the raw URL when it cannot be normalized', () => {
    const key = computeIdentityKey({ url: 'not a url', container: undefined, kind: 'video' });
    expect(key).toContain('not a url');
  });
});
