import { describe, expect, it } from 'vitest';
import { classifyQuality } from '@core/detection/quality/quality';

describe('quality classification', () => {
  it('maps frame height to standard tiers deterministically', () => {
    expect(classifyQuality('video', 2160)).toBe('2160p');
    expect(classifyQuality('video', 1440)).toBe('1440p');
    expect(classifyQuality('video', 1080)).toBe('1080p');
    expect(classifyQuality('video', 720)).toBe('720p');
    expect(classifyQuality('video', 480)).toBe('480p');
    expect(classifyQuality('video', 360)).toBe('360p');
    expect(classifyQuality('video', 240)).toBe('240p');
    expect(classifyQuality('video', 144)).toBe('144p');
  });

  it('snaps intermediate heights down to the nearest tier', () => {
    expect(classifyQuality('video', 900)).toBe('720p');
    expect(classifyQuality('video', 4000)).toBe('2160p');
  });

  it('returns audio-only for audio and unknown when height is missing or tiny', () => {
    expect(classifyQuality('audio', 0)).toBe('audio-only');
    expect(classifyQuality('audio', undefined)).toBe('audio-only');
    expect(classifyQuality('video', undefined)).toBe('unknown');
    expect(classifyQuality('video', 100)).toBe('unknown');
    expect(classifyQuality('stream', undefined)).toBe('unknown');
  });
});
