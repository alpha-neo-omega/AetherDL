import { describe, expect, it } from 'vitest';
import { getHost, isBlobUrl, isDownloadableUrl, normalizeUrl, parseUrl } from '@shared/utils';

describe('shared/utils url helpers', () => {
  it('parseUrl returns a URL for valid input and undefined otherwise', () => {
    expect(parseUrl('https://example.com/a')?.host).toBe('example.com');
    expect(parseUrl('not a url')).toBeUndefined();
  });

  it('isDownloadableUrl accepts only http(s)', () => {
    expect(isDownloadableUrl('https://example.com/v.mp4')).toBe(true);
    expect(isDownloadableUrl('http://example.com/v.mp4')).toBe(true);
    expect(isDownloadableUrl('ftp://example.com/v.mp4')).toBe(false);
    expect(isDownloadableUrl('javascript:alert(1)')).toBe(false);
    expect(isDownloadableUrl('about:blank')).toBe(false);
    expect(isDownloadableUrl('garbage')).toBe(false);
  });

  it('isBlobUrl detects blob URLs', () => {
    expect(isBlobUrl('blob:https://example.com/abc')).toBe(true);
    expect(isBlobUrl('https://example.com')).toBe(false);
  });

  it('getHost extracts host or undefined', () => {
    expect(getHost('https://sub.example.com:8080/x')).toBe('sub.example.com:8080');
    expect(getHost('nope')).toBeUndefined();
  });

  it('normalizeUrl canonicalizes host, default ports, and fragment', () => {
    expect(normalizeUrl('https://Example.COM:443/a?b=1#frag')).toBe('https://example.com/a?b=1');
    expect(normalizeUrl('http://Example.com:80/a')).toBe('http://example.com/a');
    expect(normalizeUrl('https://x.com:8443/a')).toBe('https://x.com:8443/a');
    expect(normalizeUrl('not a url')).toBeUndefined();
  });

  it('normalizeUrl preserves blob identity', () => {
    const normalized = normalizeUrl('blob:https://example.com/abc-123');
    expect(normalized).toContain('abc-123');
  });
});
