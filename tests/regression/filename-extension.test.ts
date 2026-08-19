/**
 * Regression (PROJECT_BIBLE.md §16.5, §10.7): a media title derived from the
 * media's own filename (`sample.mp4`) rendered through the default template
 * `{title}.{ext}` produced `sample.mp4.mp4`. The user saw a doubled extension on
 * every download whose page offered no separate title — the common case for a
 * direct media URL.
 *
 * The fix drops a trailing copy of the resolved extension from the `{title}` token
 * only. The token system, sanitization, extension preservation, collision handling,
 * the UTF-8 byte cap and the NAME_MAX bound are unchanged, and every one of them is
 * re-asserted here.
 */
import { describe, expect, it } from 'vitest';
import { createFilenameGenerator, resolveCollision } from '@core/download/filename/filename';
import { mediaItem } from '../unit/core/download/_fixtures';

const DEFAULT_TEMPLATE = '{title}.{ext}';
const generator = createFilenameGenerator(() => Date.parse('2026-08-19T00:00:00Z'));

const generate = (
  props: Parameters<typeof mediaItem>[0],
  template = DEFAULT_TEMPLATE,
  index?: number,
): string => generator.generate(mediaItem(props), template, index);

describe('regression: doubled extension (Phase 9)', () => {
  it('names a video whose title is already sample.mp4', () => {
    expect(
      generate({
        title: 'sample.mp4',
        url: 'https://cdn.example.com/media/sample.mp4',
        container: 'mp4',
        extension: 'mp4',
      }),
    ).toBe('sample.mp4');
  });

  it('names an audio file whose title is already sample.mp3', () => {
    expect(
      generate({
        kind: 'audio',
        title: 'sample.mp3',
        url: 'https://cdn.example.com/media/sample.mp3',
        container: 'mp3',
        extension: 'mp3',
      }),
    ).toBe('sample.mp3');
  });

  it('still appends the extension when the title has none', () => {
    expect(generate({ title: 'Holiday Clip', extension: 'mp4', container: 'mp4' })).toBe(
      'Holiday Clip.mp4',
    );
  });

  it('keeps a DIFFERENT extension in the title and appends the correct one', () => {
    // `.mkv` is part of the name the user sees; the container is still mp4, and
    // §10.7 requires the correct extension to be the effective one.
    expect(generate({ title: 'clip.mkv', extension: 'mp4', container: 'mp4' })).toBe(
      'clip.mkv.mp4',
    );
  });

  it('names a URL-derived title exactly once', () => {
    expect(
      generate({
        title: 'episode-01.webm',
        url: 'https://cdn.example.com/v/episode-01.webm',
        container: 'webm',
        extension: 'webm',
      }),
    ).toBe('episode-01.webm');
  });

  it('handles a user-authored title that ends in the extension', () => {
    expect(generate({ title: 'My Holiday.MP4', extension: 'mp4', container: 'mp4' })).toBe(
      'My Holiday.mp4',
    );
  });

  it('falls back to the stand-in name when the title is only an extension', () => {
    // Stripping leaves no base at all, so the sanitizer's existing empty-name
    // fallback applies rather than emitting `.mp4.mp4`.
    expect(generate({ title: '.mp4', extension: 'mp4', container: 'mp4' })).toBe('download.mp4');
  });

  it('applies to every template that uses {title} alongside {ext}', () => {
    expect(
      generate(
        { title: 'sample.mp4', extension: 'mp4', container: 'mp4', quality: '1080p' },
        '{title}-{quality}.{ext}',
      ),
    ).toBe('sample-1080p.mp4');
    expect(
      generate({ title: 'sample.mp4', extension: 'mp4', container: 'mp4' }, '{index}-{title}', 3),
    ).toBe('3-sample.mp4');
    expect(
      generate(
        { title: 'sample.mp4', extension: 'mp4', container: 'mp4', originHost: 'cdn.test' },
        '{host}/{title}.{ext}',
      ),
    ).toBe('cdn.test_sample.mp4');
  });

  it('leaves the name alone when no extension is known', () => {
    expect(
      generate({
        title: 'stream.m3u8',
        url: 'https://cdn.example.com/live/master',
        container: undefined,
        extension: undefined,
      }),
    ).toBe('stream.m3u8');
  });

  it('resolves collisions on the de-duplicated name', () => {
    const name = generate({ title: 'sample.mp4', extension: 'mp4', container: 'mp4' });
    const existing = new Set([name, 'sample (1).mp4']);

    expect(resolveCollision(name, existing)).toBe('sample (2).mp4');
    // The disambiguator goes before the single extension, not after a doubled one.
    expect(resolveCollision(name, existing).endsWith('.mp4.mp4')).toBe(false);
  });

  it('keeps a maximum-length name inside NAME_MAX, before and after collision', () => {
    const long = `${'a'.repeat(400)}.mp4`;
    const name = generate({ title: long, extension: 'mp4', container: 'mp4' });

    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
    expect(name.endsWith('.mp4')).toBe(true);
    expect(name.endsWith('.mp4.mp4')).toBe(false);

    const bumped = resolveCollision(name, new Set([name]));
    expect(new TextEncoder().encode(bumped).length).toBeLessThanOrEqual(255);
    expect(bumped.endsWith(' (1).mp4')).toBe(true);
  });

  it('counts multibyte titles in UTF-8 bytes and still de-duplicates', () => {
    const name = generate({ title: '休日のビデオ.mp4', extension: 'mp4', container: 'mp4' });
    expect(name).toBe('休日のビデオ.mp4');

    const longMultibyte = `${'漢'.repeat(200)}.mp4`;
    const clamped = generate({ title: longMultibyte, extension: 'mp4', container: 'mp4' });
    expect(new TextEncoder().encode(clamped).length).toBeLessThanOrEqual(255);
    expect(clamped.endsWith('.mp4')).toBe(true);
    expect(clamped.endsWith('.mp4.mp4')).toBe(false);
  });

  it('recognises the extension through surrounding whitespace', () => {
    expect(generate({ title: '  sample.mp4  ', extension: 'mp4', container: 'mp4' })).toBe(
      'sample.mp4',
    );
  });

  it('does not strip twice when the title carries the extension twice', () => {
    // One copy is dropped; the remaining one is the file's real extension.
    expect(generate({ title: 'sample.mp4.mp4', extension: 'mp4', container: 'mp4' })).toBe(
      'sample.mp4',
    );
  });

  it('still strips illegal characters from a de-duplicated title', () => {
    expect(generate({ title: 'my:clip?.mp4', extension: 'mp4', container: 'mp4' })).toBe(
      'my_clip_.mp4',
    );
  });
});
