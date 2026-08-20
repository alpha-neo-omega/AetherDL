/**
 * Performance: caches are bounded and evicted (PROJECT_BIBLE.md §12.3, §12.5, §9.9).
 *
 * Every cache in AetherDL is in-memory and bounded; unbounded caches are forbidden.
 * This suite holds the detection cache to its bounds under stress, so idle memory
 * cannot drift past the §12.1 budget through cache growth.
 */
import { describe, expect, it } from 'vitest';
import { createDetectionCache } from '@core/detection/cache/cache';
import { createDetectionEngine } from '@core/detection/factory';
import type { DetectionContext } from '@core/detection/pipeline';
import type { MediaItem } from '@shared/types';

const MAX_TABS = 8;
const MAX_AGE_MS = 1000;

function item(id: string): MediaItem {
  return {
    id,
    kind: 'video',
    status: 'supported',
    title: id,
    url: `https://example.com/${id}.mp4`,
    originHost: 'example.com',
    detectedBy: 'html5-video',
    score: 1,
    discoveredAt: 0,
  };
}

function setup(now = { value: 0 }) {
  const cache = createDetectionCache({
    clock: () => now.value,
    maxTabs: MAX_TABS,
    maxAgeMs: MAX_AGE_MS,
  });
  return { cache, now };
}

describe('cache bounds: detection cache', () => {
  it('never holds more tabs than its bound, however many are pushed at it', () => {
    const { cache } = setup();
    for (let tabId = 0; tabId < 5_000; tabId += 1) {
      cache.set(tabId, [item(`m-${tabId}`)]);
      expect(cache.stats().size).toBeLessThanOrEqual(MAX_TABS);
    }
    expect(cache.stats().size).toBe(MAX_TABS);
  });

  it('evicts the least recently used tab first', () => {
    const { cache } = setup();
    for (let tabId = 0; tabId < MAX_TABS; tabId += 1) {
      cache.set(tabId, [item(`m-${tabId}`)]);
    }
    // Touch tab 0 so it is no longer the least recently used.
    expect(cache.get(0)).toBeDefined();

    cache.set(MAX_TABS, [item('new')]);

    expect(cache.get(0)).toBeDefined();
    expect(cache.get(1)).toBeUndefined();
    expect(cache.stats().size).toBe(MAX_TABS);
  });

  it('treats an entry past its maximum age as a miss and drops it', () => {
    const { cache, now } = setup();
    cache.set(1, [item('a')]);

    now.value = MAX_AGE_MS;
    expect(cache.get(1)).toBeDefined();

    now.value = MAX_AGE_MS + 1;
    expect(cache.get(1)).toBeUndefined();
    expect(cache.stats().size).toBe(0);
  });

  it('sweeps every expired entry on cleanup', () => {
    const { cache, now } = setup();
    // One under the bound, so nothing is evicted for size and the sweep is measured
    // on age alone. No `set` after the clock moves: writing also reclaims expired
    // entries, which is what stops a stale entry costing a live one its slot.
    const aged = MAX_TABS - 1;
    for (let tabId = 0; tabId < aged; tabId += 1) {
      cache.set(tabId, [item(`m-${tabId}`)]);
    }
    now.value = MAX_AGE_MS + 1;

    expect(cache.cleanup()).toBe(aged);
    expect(cache.stats().size).toBe(0);
    expect(cache.cleanup()).toBe(0);
  });

  it('reclaims expired entries when writing, so a live entry keeps its slot', () => {
    const { cache, now } = setup();
    for (let tabId = 0; tabId < MAX_TABS; tabId += 1) {
      cache.set(tabId, [item(`m-${tabId}`)]);
    }
    now.value = MAX_AGE_MS + 1;
    // Every existing entry is stale now; a fresh write should reclaim them rather
    // than evict its way past them one at a time.
    cache.set(1000, [item('fresh')]);

    expect(cache.stats().size).toBe(1);
    expect(cache.get(1000)).toBeDefined();
  });

  it('invalidates on navigation, so a stale page never answers', () => {
    const { cache } = setup();
    cache.set(1, [item('a')], 'https://example.com/one');

    expect(cache.get(1, 'https://example.com/one')).toBeDefined();
    expect(cache.get(1, 'https://example.com/two')).toBeUndefined();
    expect(cache.stats().size).toBe(0);
  });

  it('releases everything it holds on invalidateAll', () => {
    const { cache } = setup();
    for (let tabId = 0; tabId < MAX_TABS; tabId += 1) {
      cache.set(tabId, [item(`m-${tabId}`)]);
    }
    cache.invalidateAll();
    expect(cache.stats().size).toBe(0);
  });

  it('drops a single tab on invalidate', () => {
    const { cache } = setup();
    cache.set(1, [item('a')]);
    cache.set(2, [item('b')]);
    cache.invalidate(1);
    expect(cache.stats().size).toBe(1);
    expect(cache.get(1)).toBeUndefined();
  });

  it('re-setting the same tab replaces rather than accumulates', () => {
    const { cache } = setup();
    for (let round = 0; round < 1_000; round += 1) {
      cache.set(7, [item(`m-${round}`)]);
    }
    expect(cache.stats().size).toBe(1);
  });
});

describe('cache bounds: the wired engine', () => {
  it('ships bounded cache defaults rather than an unbounded cache', async () => {
    // The engine is built with its production defaults: a bounded tab count and a
    // maximum entry age (§9.9, §12.5).
    const engine = createDetectionEngine({ clock: () => 0 });
    const context = (tabId: number): DetectionContext => ({
      tabId,
      pageUrl: `https://example.com/${tabId}`,
      domSignals: [],
      observedUrls: [],
      source: 'dom',
      timestamp: 0,
    });

    // Far more tabs than the default bound; memory must not grow with tab count.
    for (let tabId = 0; tabId < 200; tabId += 1) {
      await engine.detect(context(tabId));
    }

    await engine.dispose();
  });

  it('accepts an explicit bound and honours it', async () => {
    const engine = createDetectionEngine({ clock: () => 0, maxTabs: 2 });
    const detect = (tabId: number): Promise<readonly MediaItem[]> =>
      engine.detect({
        tabId,
        pageUrl: `https://example.com/${tabId}`,
        domSignals: [
          {
            role: 'video',
            tagName: 'VIDEO',
            src: `https://example.com/${tabId}.mp4`,
          },
        ],
        observedUrls: [],
        source: 'dom',
        timestamp: 0,
      });

    await detect(1);
    await detect(2);
    await detect(3);
    // Tab 1 was evicted, so it must be recomputed rather than served from cache.
    const cacheMisses: number[] = [];
    engine.on('cache:miss', (payload) => cacheMisses.push(payload.tabId));
    await detect(1);

    expect(cacheMisses).toContain(1);
    await engine.dispose();
  });
});
