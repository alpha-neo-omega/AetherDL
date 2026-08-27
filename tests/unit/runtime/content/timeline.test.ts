/**
 * The resource timeline the background identifies media from (PROJECT_BIBLE.md §8.10,
 * §9.1, ADR-012).
 *
 * This file exists because of a shipped regression. 1.8.2 bounded the observation list
 * by evicting the OLDEST entry to make room for each new one. On a page playing a long
 * video that converges on the last N requests — all of them segments — and throws away
 * the playlist, which a player fetches first and which therefore sits at the head. A
 * stream that was being detected stopped being detected, permanently, and nothing here
 * could catch it: the logic lived in the coverage-excluded entry module.
 */
import { describe, expect, it } from 'vitest';
import { MAX_OBSERVED_RESOURCES } from '@shared/constants';
import { createResourceTimeline, isInterestingInitiator } from '@runtime/content/timeline';

const entry = (name: string, initiatorType = 'fetch', transferSize?: number) => ({
  name,
  initiatorType,
  ...(transferSize !== undefined && { transferSize }),
});

/** A frozen buffer shaped like a real one: boot requests, the playlist, then segments. */
function longSession(playlistUrl: string, segments = 400) {
  return [
    entry('https://site.test/api/config.json'),
    entry('https://site.test/api/sources.json'),
    entry(playlistUrl),
    ...Array.from({ length: segments }, (_, index) =>
      entry(`https://cdn.test/seg-${String(index)}.css`, 'fetch', 1024),
    ),
  ];
}

describe('runtime/content resource timeline', () => {
  it('keeps the playlist when a page fetches far more segments than the cap allows', () => {
    // The regression, exactly: the playlist is at the head, the cap is reached long
    // before the segments run out, and evicting the oldest would discard it.
    const playlist = 'https://cdn.test/hls/index-v1-a1.txt';
    const timeline = createResourceTimeline();

    const harvested = timeline.harvest(longSession(playlist));

    expect(harvested).toHaveLength(MAX_OBSERVED_RESOURCES);
    expect(harvested.map((resource) => resource.url)).toContain(playlist);
  });

  it('holds that list steady however many times the same timeline is read', () => {
    // The content script rescans on every mutation, and a video page mutates
    // constantly. A list that churned would make detection depend on when it was read.
    const playlist = 'https://cdn.test/hls/index-v1-a1.txt';
    const timeline = createResourceTimeline();
    const entries = longSession(playlist);

    const first = timeline.harvest(entries).map((resource) => resource.url);
    timeline.harvest(entries);
    const third = timeline.harvest(entries).map((resource) => resource.url);

    expect(third).toStrictEqual(first);
    expect(third).toContain(playlist);
  });

  it('makes room for a manifest discovered after the list is already full', () => {
    const timeline = createResourceTimeline({ maxEntries: 3 });
    timeline.harvest([entry('https://cdn.test/a.css'), entry('https://cdn.test/b.css')]);
    timeline.harvest([entry('https://cdn.test/c.css'), entry('https://cdn.test/d.css')]);

    // Full of segments — and a playlist still gets in, by displacing the oldest.
    const harvested = timeline.harvest([entry('https://cdn.test/late/master.m3u8')]);

    expect(harvested.map((resource) => resource.url)).toStrictEqual([
      'https://cdn.test/b.css',
      'https://cdn.test/c.css',
      'https://cdn.test/late/master.m3u8',
    ]);
  });

  it('never evicts a manifest to make room for anything', () => {
    const timeline = createResourceTimeline({ maxEntries: 2 });
    timeline.harvest([entry('https://cdn.test/master.m3u8'), entry('https://cdn.test/a.css')]);

    const harvested = timeline.harvest([
      entry('https://cdn.test/b.css'),
      entry('https://cdn.test/second.mpd'),
    ]);

    // The DASH manifest displaced the segment; the HLS one was never a candidate for it.
    expect(harvested.map((resource) => resource.url)).toStrictEqual([
      'https://cdn.test/master.m3u8',
      'https://cdn.test/second.mpd',
    ]);
  });

  it('keeps what it saw when the page clears its own timeline', () => {
    // Some players call performance.clearResourceTimings(). Re-reading would then
    // report a page with no playlist in it and un-detect a stream already found.
    const playlist = 'https://cdn.test/hls/master.m3u8';
    const timeline = createResourceTimeline();
    timeline.harvest([entry(playlist), entry('https://cdn.test/seg-0.css')]);

    expect(timeline.harvest([]).map((resource) => resource.url)).toStrictEqual([
      playlist,
      'https://cdn.test/seg-0.css',
    ]);
  });

  it('reports only what a script could have fetched, and only over http(s)', () => {
    const timeline = createResourceTimeline();

    const harvested = timeline.harvest([
      entry('https://cdn.test/playlist.m3u8', 'xmlhttprequest'),
      entry('https://cdn.test/style.css', 'link'),
      entry('https://cdn.test/logo.png', 'img'),
      entry('https://cdn.test/frame.html', 'iframe'),
      entry('data:text/plain,hello', 'fetch'),
      entry('blob:https://site.test/abc', 'video'),
      entry('https://cdn.test/clip.mp4', 'video'),
    ]);

    expect(harvested.map((resource) => resource.url)).toStrictEqual([
      'https://cdn.test/playlist.m3u8',
      'https://cdn.test/clip.mp4',
    ]);
  });

  it('carries a known transfer size and omits an unknown one', () => {
    const timeline = createResourceTimeline();

    const harvested = timeline.harvest([
      entry('https://cdn.test/known.m3u8', 'fetch', 2048),
      // Cross-origin without Timing-Allow-Origin: zero means unknown, not empty.
      entry('https://cdn.test/opaque.m3u8', 'fetch', 0),
      { name: 'https://cdn.test/body.m3u8', initiatorType: 'fetch', encodedBodySize: 512 },
    ]);

    expect(harvested).toStrictEqual([
      { url: 'https://cdn.test/known.m3u8', initiatorType: 'fetch', sizeBytes: 2048 },
      { url: 'https://cdn.test/opaque.m3u8', initiatorType: 'fetch' },
      { url: 'https://cdn.test/body.m3u8', initiatorType: 'fetch', sizeBytes: 512 },
    ]);
  });

  it('reports a resource once, at the position it was first seen', () => {
    const timeline = createResourceTimeline();
    timeline.harvest([entry('https://cdn.test/a.m3u8'), entry('https://cdn.test/b.css')]);

    const harvested = timeline.harvest([
      entry('https://cdn.test/b.css'),
      entry('https://cdn.test/a.m3u8'),
    ]);

    expect(harvested.map((resource) => resource.url)).toStrictEqual([
      'https://cdn.test/a.m3u8',
      'https://cdn.test/b.css',
    ]);
  });

  it('knows which initiators a player could have used', () => {
    expect(isInterestingInitiator('fetch')).toBe(true);
    expect(isInterestingInitiator('XMLHttpRequest')).toBe(true);
    expect(isInterestingInitiator('video')).toBe(true);
    expect(isInterestingInitiator(undefined)).toBe(true);
    expect(isInterestingInitiator('link')).toBe(false);
    expect(isInterestingInitiator('img')).toBe(false);
  });
});
