import { describe, expect, it } from 'vitest';
import {
  createFilenameGenerator,
  resolveCollision,
  sanitizeFilename,
} from '@core/download/filename/filename';
import { mediaItem } from './_fixtures';

describe('filename system', () => {
  it('sanitizes illegal/control characters but preserves spaces and hyphens', () => {
    expect(sanitizeFilename('My: Video/Clip*?.mp4')).toBe('My_ Video_Clip__.mp4');
    expect(sanitizeFilename('a-b c.mp4')).toBe('a-b c.mp4');
    expect(sanitizeFilename('   ')).toBe('download');
    expect(sanitizeFilename('trailing...')).toBe('trailing');
  });

  it('resolves collisions by inserting " (n)" before the extension', () => {
    const existing = new Set(['clip.mp4', 'clip (1).mp4']);
    expect(resolveCollision('clip.mp4', existing)).toBe('clip (2).mp4');
    expect(resolveCollision('fresh.mp4', existing)).toBe('fresh.mp4');
  });

  it('generates from a template, replacing tokens and preserving the extension', () => {
    const gen = createFilenameGenerator(() => Date.parse('2026-07-16T00:00:00Z'));
    const name = gen.generate(
      mediaItem({ title: 'Great Clip', originHost: 'x.com', extension: 'mp4', quality: '1080p' }),
      '{title}-{quality}-{date}.{ext}',
      0,
    );
    expect(name).toBe('Great Clip-1080p-2026-07-16.mp4');
  });

  it('appends the known extension when the template omits it', () => {
    const gen = createFilenameGenerator(() => 0);
    const name = gen.generate(mediaItem({ title: 'NoExt', extension: 'webm' }), '{title}');
    expect(name).toBe('NoExt.webm');
  });

  it('fills {index} for batch numbering and tolerates unknown extension', () => {
    const gen = createFilenameGenerator(() => 0);
    const name = gen.generate(
      mediaItem({
        title: 'Item',
        extension: undefined,
        container: undefined,
        url: 'https://x.com/stream',
      }),
      '{title}-{index}.{ext}',
      3,
    );
    expect(name).toBe('Item-3');
  });

  it('bounds total filename length under the OS NAME_MAX including the extension', () => {
    // Untrusted container/extension must not push the total past 255 bytes.
    const hugeExt = sanitizeFilename(`clip.${'x'.repeat(300)}`);
    expect(hugeExt.length).toBeLessThanOrEqual(255);
    const hugeBase = sanitizeFilename(`${'y'.repeat(400)}.mp4`);
    expect(hugeBase.length).toBeLessThanOrEqual(255);
    expect(hugeBase.endsWith('.mp4')).toBe(true);
  });

  it('caps the total in UTF-8 BYTES for multibyte names', () => {
    const cjk = '車'.repeat(200); // 3 bytes each ≈ 600 bytes
    const out = sanitizeFilename(`${cjk}.mp4`);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(255);
    expect(out.endsWith('.mp4')).toBe(true);
  });

  it('inserts untrusted title text literally — $-sequences and token literals are not interpreted', () => {
    const gen = createFilenameGenerator(() => 0);
    expect(
      gen.generate(mediaItem({ title: 'Cash $$ $& money', extension: 'mp4' }), '{title}.{ext}'),
    ).toBe('Cash $$ $& money.mp4');
    // A literal token appearing in the title must NOT be re-substituted.
    expect(gen.generate(mediaItem({ title: '{ext}', extension: 'mp4' }), '{title}.{ext}')).toBe(
      '{ext}.mp4',
    );
  });

  it('does not double a long/oversized extension', () => {
    const gen = createFilenameGenerator(() => 0);
    const out = gen.generate(
      mediaItem({ title: 'video', extension: 'x'.repeat(300) }),
      '{title}.{ext}',
    );
    expect(out.length).toBeLessThanOrEqual(255);
    // Exactly one extension segment.
    expect(out.split('.')).toHaveLength(2);
  });

  it('does not double the extension when the name contains a # (URL-fragment char)', () => {
    const gen = createFilenameGenerator(() => 0);
    // '#' is legal in filenames; the append-guard must not treat it as a fragment.
    expect(gen.generate(mediaItem({ title: 'clip#42', extension: 'mp4' }), '{title}.{ext}')).toBe(
      'clip#42.mp4',
    );
  });

  it('strips trailing dots even when trailing whitespace follows them', () => {
    expect(sanitizeFilename('report. ')).toBe('report');
    expect(sanitizeFilename('report.  .')).toBe('report');
  });

  it('keeps a collision-resolved name within the byte cap', () => {
    // A near-max-length multibyte name must not overflow NAME_MAX once ` (n)` is added.
    const atCap = sanitizeFilename(`${'車'.repeat(300)}.mp4`);
    const resolved = resolveCollision(atCap, new Set([atCap]));
    expect(resolved).not.toBe(atCap);
    expect(new TextEncoder().encode(resolved).length).toBeLessThanOrEqual(255);
  });
});
