import { describe, expect, it } from 'vitest';
import { createDetectionCache } from '@core/detection/cache/cache';
import type { MediaItem } from '@shared/types';

function items(id: string): readonly MediaItem[] {
  return [
    {
      id,
      kind: 'video',
      status: 'supported',
      title: id,
      url: `https://x.com/${id}.mp4`,
      originHost: 'x.com',
      detectedBy: 'd',
      score: 1,
      discoveredAt: 0,
    },
  ];
}

describe('detection cache', () => {
  it('stores and retrieves per-tab, counting hits and misses', () => {
    const now = 0;
    const cache = createDetectionCache({ clock: () => now, maxTabs: 10, maxAgeMs: 1000 });
    expect(cache.get(1)).toBeUndefined();
    cache.set(1, items('a'), 'https://x.com/watch');
    expect(cache.get(1, 'https://x.com/watch')).toHaveLength(1);
    const stats = cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.size).toBe(1);
  });

  it('expires entries past max age', () => {
    let now = 0;
    const cache = createDetectionCache({ clock: () => now, maxTabs: 10, maxAgeMs: 100 });
    cache.set(1, items('a'));
    now = 150;
    expect(cache.get(1)).toBeUndefined();
  });

  it('invalidates on page navigation', () => {
    const cache = createDetectionCache({ clock: () => 0, maxTabs: 10, maxAgeMs: 1000 });
    cache.set(1, items('a'), 'https://x.com/one');
    expect(cache.get(1, 'https://x.com/two')).toBeUndefined();
  });

  it('evicts the least-recently-used tab beyond maxTabs', () => {
    const cache = createDetectionCache({ clock: () => 0, maxTabs: 2, maxAgeMs: 10_000 });
    cache.set(1, items('a'));
    cache.set(2, items('b'));
    cache.get(1); // touch tab 1 → tab 2 becomes LRU
    cache.set(3, items('c')); // evicts tab 2
    expect(cache.get(1)).toBeDefined();
    expect(cache.get(2)).toBeUndefined();
    expect(cache.get(3)).toBeDefined();
  });

  it('supports explicit invalidation and cleanup', () => {
    let now = 0;
    const cache = createDetectionCache({ clock: () => now, maxTabs: 10, maxAgeMs: 100 });
    cache.set(1, items('a'));
    cache.set(2, items('b'));
    cache.invalidate(1);
    expect(cache.get(1)).toBeUndefined();
    now = 200;
    expect(cache.cleanup()).toBe(1);
    expect(cache.stats().size).toBe(0);
    cache.set(3, items('c'));
    cache.invalidateAll();
    expect(cache.stats().size).toBe(0);
  });
});

describe('detection cache: expiry does not cost a live entry its slot', () => {
  it('evicts what has expired before evicting what has not', () => {
    let now = 0;
    const cache = createDetectionCache({ clock: () => now, maxTabs: 2, maxAgeMs: 100 });

    cache.set(1, []);
    now += 200; // tab 1's entry is now stale, but nothing has read it
    cache.set(2, []);
    cache.set(3, []);

    // Tab 2 survives: the stale entry for tab 1 was reclaimed first.
    expect(cache.get(2)).toBeDefined();
    expect(cache.get(3)).toBeDefined();
    expect(cache.get(1)).toBeUndefined();
  });
});
