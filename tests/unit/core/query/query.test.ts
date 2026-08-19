import { describe, expect, it } from 'vitest';
import { createQueryEngine } from '@core/query/query';
import type { FilterSpec, SortSpec } from '@core/query';
import type { MediaItem } from '@shared/types';

function item(props: Partial<MediaItem> & { readonly id: string }): MediaItem {
  return {
    kind: 'video',
    status: 'supported',
    title: props.id,
    url: `https://example.com/${props.id}.mp4`,
    originHost: 'example.com',
    detectedBy: 'html5-video',
    score: 1,
    discoveredAt: 0,
    ...props,
  };
}

const engine = createQueryEngine();
const ALL: FilterSpec = {};
const BY_SCORE: SortSpec = { key: 'score', direction: 'desc' };
const BY_TITLE: SortSpec = { key: 'title', direction: 'asc' };

describe('core/query engine', () => {
  it('returns everything when the filter is empty', () => {
    const items = [item({ id: 'a' }), item({ id: 'b' })];
    expect(engine.apply(items, ALL, BY_TITLE).map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('filters by kind', () => {
    const items = [item({ id: 'v' }), item({ id: 'a', kind: 'audio' })];
    expect(engine.apply(items, { kind: 'audio' }, BY_TITLE).map((entry) => entry.id)).toEqual([
      'a',
    ]);
  });

  it('filters by container, case-insensitively', () => {
    const items = [item({ id: 'a', container: 'mp4' }), item({ id: 'b', container: 'webm' })];
    expect(engine.apply(items, { container: 'MP4' }, BY_TITLE).map((entry) => entry.id)).toEqual([
      'a',
    ]);
    expect(engine.apply(items, { container: 'mkv' }, BY_TITLE)).toEqual([]);
  });

  it('filters by host', () => {
    const items = [item({ id: 'a' }), item({ id: 'b', originHost: 'other.test' })];
    expect(engine.apply(items, { host: 'other.test' }, BY_TITLE).map((entry) => entry.id)).toEqual([
      'b',
    ]);
  });

  it('searches title, host and type case-insensitively', () => {
    const items = [
      item({ id: 'a', title: 'Holiday Clip', container: 'mp4' }),
      item({ id: 'b', title: 'Lecture', originHost: 'campus.test', container: 'webm' }),
    ];
    expect(engine.apply(items, { text: 'holiday' }, BY_TITLE).map((entry) => entry.id)).toEqual([
      'a',
    ]);
    expect(engine.apply(items, { text: 'CAMPUS' }, BY_TITLE).map((entry) => entry.id)).toEqual([
      'b',
    ]);
    expect(engine.apply(items, { text: 'webm' }, BY_TITLE).map((entry) => entry.id)).toEqual(['b']);
    expect(engine.apply(items, { text: '   ' }, BY_TITLE)).toHaveLength(2);
  });

  it('combines filters conjunctively', () => {
    const items = [
      item({ id: 'a', kind: 'audio', title: 'Podcast' }),
      item({ id: 'b', kind: 'audio', title: 'Song' }),
    ];
    expect(
      engine.apply(items, { kind: 'audio', text: 'song' }, BY_TITLE).map((entry) => entry.id),
    ).toEqual(['b']);
  });

  it('sorts by score descending and by title ascending', () => {
    const items = [
      item({ id: 'low', title: 'Zebra', score: 1 }),
      item({ id: 'high', title: 'Apple', score: 9 }),
    ];
    expect(engine.apply(items, ALL, BY_SCORE).map((entry) => entry.id)).toEqual(['high', 'low']);
    expect(engine.apply(items, ALL, BY_TITLE).map((entry) => entry.id)).toEqual(['high', 'low']);
  });

  it('sorts by size and duration', () => {
    const items = [
      item({ id: 'small', sizeBytes: 10, durationSec: 5 }),
      item({ id: 'big', sizeBytes: 900, durationSec: 500 }),
    ];
    expect(
      engine.apply(items, ALL, { key: 'sizeBytes', direction: 'desc' }).map((entry) => entry.id),
    ).toEqual(['big', 'small']);
    expect(
      engine.apply(items, ALL, { key: 'durationSec', direction: 'asc' }).map((entry) => entry.id),
    ).toEqual(['small', 'big']);
  });

  it('sorts by discovery time', () => {
    const items = [item({ id: 'old', discoveredAt: 10 }), item({ id: 'new', discoveredAt: 99 })];
    expect(
      engine.apply(items, ALL, { key: 'discoveredAt', direction: 'desc' }).map((entry) => entry.id),
    ).toEqual(['new', 'old']);
  });

  it('matches the search against the MIME type when there is no container', () => {
    const items = [
      item({ id: 'a', mimeType: 'video/webm' }),
      item({ id: 'b', mimeType: 'audio/mpeg' }),
    ];
    expect(engine.apply(items, { text: 'webm' }, BY_TITLE).map((entry) => entry.id)).toEqual(['a']);
  });

  it('excludes an item with no container from a container filter', () => {
    const items = [item({ id: 'a' }), item({ id: 'b', container: 'mp4' })];
    expect(engine.apply(items, { container: 'mp4' }, BY_TITLE).map((entry) => entry.id)).toEqual([
      'b',
    ]);
  });

  it('sinks items missing the sort key whichever order they arrive in', () => {
    const known = item({ id: 'known', sizeBytes: 5 });
    const unknown = item({ id: 'unknown' });
    for (const input of [
      [known, unknown],
      [unknown, known],
    ]) {
      expect(
        engine.apply(input, ALL, { key: 'sizeBytes', direction: 'desc' }).map((entry) => entry.id),
      ).toEqual(['known', 'unknown']);
    }
  });

  it('sinks items missing the sort key, in both directions', () => {
    const items = [item({ id: 'unknown' }), item({ id: 'known', sizeBytes: 5 })];
    expect(
      engine.apply(items, ALL, { key: 'sizeBytes', direction: 'asc' }).map((entry) => entry.id),
    ).toEqual(['known', 'unknown']);
    expect(
      engine.apply(items, ALL, { key: 'sizeBytes', direction: 'desc' }).map((entry) => entry.id),
    ).toEqual(['known', 'unknown']);
  });

  it('is deterministic for equal items via a stable id tiebreak', () => {
    const items = [item({ id: 'c', title: 'Same' }), item({ id: 'a', title: 'Same' })];
    const first = engine.apply(items, ALL, BY_TITLE).map((entry) => entry.id);
    const second = engine.apply([...items].reverse(), ALL, BY_TITLE).map((entry) => entry.id);
    expect(first).toEqual(['a', 'c']);
    expect(second).toEqual(first);
  });

  it('orders two items that both lack the sort key deterministically', () => {
    const items = [item({ id: 'b' }), item({ id: 'a' })];
    expect(
      engine.apply(items, ALL, { key: 'durationSec', direction: 'desc' }).map((entry) => entry.id),
    ).toEqual(['a', 'b']);
  });

  it('never mutates the input array', () => {
    const items = [item({ id: 'b', score: 1 }), item({ id: 'a', score: 2 })];
    const snapshot = items.map((entry) => entry.id);
    engine.apply(items, ALL, BY_SCORE);
    expect(items.map((entry) => entry.id)).toEqual(snapshot);
  });
});
