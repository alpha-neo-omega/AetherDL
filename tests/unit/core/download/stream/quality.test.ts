/**
 * Rendition selection (PROJECT_BIBLE.md §10.6).
 *
 * The behaviour these tests pin down is the behaviour a user actually notices: asking
 * for 720p on a manifest that has no 720p rendition, pinning a quality and having it
 * honoured, and — the case that decided the design — a cap that excludes everything,
 * where refusing to download would obey the setting and defeat its purpose.
 */
import { describe, expect, it } from 'vitest';
import {
  heightCapOf,
  isPreferredRendition,
  selectRendition,
  STREAM_QUALITY_PREFERENCES,
  type Rendition,
} from '@core/download/stream/quality';

/** A ladder shaped like a real one: heights ascending, bitrates with it. */
const LADDER: readonly Rendition[] = [
  { id: 'r240', height: 240, width: 426, bandwidth: 300_000, codecs: 'avc1.42000d' },
  { id: 'r480', height: 480, width: 854, bandwidth: 900_000, codecs: 'avc1.4d401e' },
  { id: 'r720', height: 720, width: 1280, bandwidth: 2_400_000, codecs: 'avc1.4d401f' },
  { id: 'r1080', height: 1080, width: 1920, bandwidth: 6_000_000, codecs: 'avc1.640028' },
  { id: 'r2160', height: 2160, width: 3840, bandwidth: 15_000_000, codecs: 'avc1.640033' },
];

describe('core/download/stream rendition selection', () => {
  it('takes the highest bandwidth by default, which is what 1.1.0 through 1.3.0 did', () => {
    expect(selectRendition(LADDER)?.id).toBe('r2160');
    expect(selectRendition(LADDER, {})?.id).toBe('r2160');
    expect(selectRendition(LADDER, { preference: 'highest' })?.id).toBe('r2160');
  });

  it('takes the smallest for "lowest"', () => {
    expect(selectRendition(LADDER, { preference: 'lowest' })?.id).toBe('r240');
  });

  it('treats a height preference as a ceiling, not an exact match', () => {
    expect(selectRendition(LADDER, { preference: '1080' })?.id).toBe('r1080');
    expect(selectRendition(LADDER, { preference: '720' })?.id).toBe('r720');
    expect(selectRendition(LADDER, { preference: '480' })?.id).toBe('r480');
    // 1440 is not on this ladder: the best copy at or below it is 1080.
    expect(selectRendition(LADDER, { preference: '1440' })?.id).toBe('r1080');
  });

  it('takes the smallest rendition when every one exceeds the cap', () => {
    const tall: readonly Rendition[] = [
      { id: 'a', height: 1440, bandwidth: 9_000_000 },
      { id: 'b', height: 2160, bandwidth: 15_000_000 },
    ];
    // Not a refusal: the user asked for a smaller copy, not for no copy.
    expect(selectRendition(tall, { preference: '480' })?.id).toBe('a');
  });

  it('prefers the higher bitrate among renditions of the same height', () => {
    const sameHeight: readonly Rendition[] = [
      { id: 'low', height: 1080, bandwidth: 4_000_000 },
      { id: 'high', height: 1080, bandwidth: 7_000_000 },
    ];
    expect(selectRendition(sameHeight, { preference: '1080' })?.id).toBe('high');
  });

  it('falls back to bandwidth when the manifest declares no heights', () => {
    const unmeasured: readonly Rendition[] = [
      { id: 'small', bandwidth: 500_000 },
      { id: 'big', bandwidth: 5_000_000 },
    ];
    // A cap cannot be applied to something that never said how tall it is.
    expect(selectRendition(unmeasured, { preference: '480' })?.id).toBe('big');
    expect(selectRendition(unmeasured, { preference: 'lowest' })?.id).toBe('small');
  });

  it('honours a pinned rendition over the preference', () => {
    expect(selectRendition(LADDER, { renditionId: 'r240', preference: 'highest' })?.id).toBe(
      'r240',
    );
    expect(selectRendition(LADDER, { renditionId: 'r2160', preference: '480' })?.id).toBe('r2160');
  });

  it('falls back to the preference when a pinned rendition is gone', () => {
    // The stream was re-packaged between the pick and the download. Losing the
    // choice is better than failing the download over a stale id.
    expect(selectRendition(LADDER, { renditionId: 'r999', preference: '720' })?.id).toBe('r720');
  });

  it('selects nothing from nothing', () => {
    expect(selectRendition([], { preference: 'highest' })).toBeUndefined();
    expect(selectRendition([], { renditionId: 'r720' })).toBeUndefined();
  });

  it('does not mutate the list it was given', () => {
    const order = LADDER.map((rendition) => rendition.id);
    selectRendition(LADDER, { preference: 'lowest' });
    selectRendition(LADDER, { preference: '720' });
    expect(LADDER.map((rendition) => rendition.id)).toStrictEqual(order);
  });

  it('reads a cap out of every preference exactly once', () => {
    expect(heightCapOf('highest')).toBeUndefined();
    expect(heightCapOf('lowest')).toBeUndefined();
    expect(heightCapOf(undefined)).toBeUndefined();
    expect(heightCapOf('2160')).toBe(2160);
    expect(heightCapOf('1440')).toBe(1440);
    expect(heightCapOf('1080')).toBe(1080);
    expect(heightCapOf('720')).toBe(720);
    expect(heightCapOf('480')).toBe(480);
  });

  it('resolves every ratified preference to a rendition', () => {
    // A preference the settings validator accepts must never leave selection with
    // nothing to download; that would be a valid setting that breaks the feature.
    for (const preference of STREAM_QUALITY_PREFERENCES) {
      expect(selectRendition(LADDER, { preference })).toBeDefined();
    }
  });

  it('reports which rendition a chooser should mark as preferred', () => {
    expect(isPreferredRendition(LADDER[2] as Rendition, LADDER, { preference: '720' })).toBe(true);
    expect(isPreferredRendition(LADDER[4] as Rendition, LADDER, { preference: '720' })).toBe(false);
  });
});
