import { describe, expect, it } from 'vitest';
import type { DetectionReport } from '@shared/types';
import { createRuntimeState } from '@runtime/background/state';
import { mediaItem, report } from '../_fixtures';

function makeState(): ReturnType<typeof createRuntimeState> {
  let t = 0;
  return createRuntimeState({ clock: () => (t += 1) });
}

describe('runtime state', () => {
  it('creates and reads a tab record', () => {
    const state = makeState();
    const tab = state.ensureTab(1, 'https://x.com');
    expect(tab).toMatchObject({ tabId: 1, url: 'https://x.com', status: 'idle', itemCount: 0 });
    expect(state.getTab(1)?.tabId).toBe(1);
    expect(state.tabs()).toHaveLength(1);
  });

  it('setItems stores items, derives supported count, and marks detected', () => {
    const state = makeState();
    state.setItems(1, [
      mediaItem({ id: 'a', status: 'supported' }),
      mediaItem({ id: 'b', status: 'unsupported' }),
      mediaItem({ id: 'c', status: 'supported' }),
    ]);
    expect(state.getItems(1)).toHaveLength(3);
    expect(state.getTab(1)?.itemCount).toBe(2);
    expect(state.getTab(1)?.status).toBe('detected');
  });

  it('stores + clears reports and detection results', () => {
    const state = makeState();
    state.setReport(1, report({ pageUrl: 'https://x.com' }));
    expect(state.getReport(1)?.pageUrl).toBe('https://x.com');
    expect(state.getTab(1)?.connected).toBe(true);
    state.setItems(1, [mediaItem()]);
    state.clearDetection(1);
    expect(state.getItems(1)).toEqual([]);
    expect(state.getReport(1)).toBeUndefined();
    expect(state.getTab(1)?.status).toBe('idle');
    expect(state.getTab(1)?.itemCount).toBe(0);
  });

  it('tracks the active tab and connected count', () => {
    const state = makeState();
    state.setReport(1, report());
    state.setReport(2, report());
    state.setActiveTab(2);
    expect(state.activeTabId()).toBe(2);
    expect(state.connectedCount()).toBe(2);
  });

  it('counts outstanding operations and balances begin/end', () => {
    const state = makeState();
    state.beginOperation(1);
    state.beginOperation(1);
    state.beginOperation(2);
    expect(state.outstandingCount()).toBe(3);
    state.endOperation(1);
    state.endOperation(1);
    state.endOperation(2);
    expect(state.outstandingCount()).toBe(0);
  });

  it('removes a tab and clears its active status + operations', () => {
    const state = makeState();
    state.ensureTab(5);
    state.setActiveTab(5);
    state.beginOperation(5);
    state.removeTab(5);
    expect(state.getTab(5)).toBeUndefined();
    expect(state.activeTabId()).toBeUndefined();
    expect(state.outstandingCount()).toBe(0);
  });

  it('reports deterministic health', () => {
    const state = makeState();
    state.ensureTab(1);
    state.setReport(1, report());
    state.recordRun();
    state.recordError();
    const health = state.health();
    expect(health).toMatchObject({
      tabCount: 1,
      connectedCount: 1,
      outstanding: 0,
      detectionRuns: 1,
      errors: 1,
    });
    expect(typeof health.startedAt).toBe('number');
    expect(health.lastErrorAt).toBeGreaterThan(0);
  });
});

describe('runtime state: tracked tabs are bounded (§12.1)', () => {
  it('drops the least-recently-updated tab once the bound is passed', () => {
    // Regression: every tracked tab held its last report — up to 500 DOM signals and
    // 500 observed URLs — and entries were only dropped when the tab closed, so a long
    // session with many tabs grew without bound.
    let now = 0;
    const state = createRuntimeState({
      clock: () => {
        now += 1;
        return now;
      },
      maxTabs: 3,
    });

    for (const tabId of [1, 2, 3]) {
      state.ensureTab(tabId);
    }
    state.setItems(1, []);
    expect(state.tabs().map((tab) => tab.tabId)).toEqual([1, 2, 3]);

    state.ensureTab(4);

    // Tab 2 was the oldest untouched one; tab 1 was updated more recently.
    expect(
      state
        .tabs()
        .map((tab) => tab.tabId)
        .sort(),
    ).toEqual([1, 3, 4]);
  });

  it('never drops the active tab, however stale it looks', () => {
    let now = 0;
    const state = createRuntimeState({
      clock: () => {
        now += 1;
        return now;
      },
      maxTabs: 2,
    });

    state.ensureTab(1);
    state.setActiveTab(1);
    state.ensureTab(2);
    state.ensureTab(3);

    expect(state.tabs().some((tab) => tab.tabId === 1)).toBe(true);
  });

  it('never drops a tab with work in flight', () => {
    let now = 0;
    const state = createRuntimeState({
      clock: () => {
        now += 1;
        return now;
      },
      maxTabs: 2,
    });

    state.ensureTab(1);
    state.beginOperation(1);
    state.ensureTab(2);
    state.ensureTab(3);

    // Evicting it would discard state the in-flight detection is about to write.
    expect(state.tabs().some((tab) => tab.tabId === 1)).toBe(true);
  });

  it('a dropped tab simply detects again, rather than showing stale media', () => {
    let now = 0;
    const state = createRuntimeState({
      clock: () => {
        now += 1;
        return now;
      },
      maxTabs: 1,
    });

    state.setItems(1, []);
    state.ensureTab(2);

    expect(state.getItems(1)).toEqual([]);
    expect(state.getReport(1)).toBeUndefined();
  });
});

describe('runtime state — one report per frame (§8.10)', () => {
  const frame = (url: string, extra: Partial<DetectionReport> = {}): DetectionReport => ({
    pageUrl: url,
    domSignals: [],
    observedUrls: [],
    ...extra,
  });

  it('keeps each frame beside the others instead of replacing', () => {
    // A video host wraps its player in an `/embed/` iframe: the top document holds no
    // media at all, and the frame holds everything. A later report from one frame must
    // not erase what the other observed.
    const state = createRuntimeState({ clock: () => 0 });
    state.ensureTab(1, 'https://site.test/watch');
    state.setReport(
      1,
      frame('https://site.test/watch', { observedUrls: ['https://a.test/x.mp4'] }),
    );
    state.setReport(
      1,
      frame('https://site.test/embed/abc', { observedUrls: ['https://b.test/y.m3u8'] }),
    );

    const merged = state.getReport(1);

    expect(merged?.observedUrls).toStrictEqual(['https://a.test/x.mp4', 'https://b.test/y.m3u8']);
    expect(state.getFrameReports(1)).toHaveLength(2);
  });

  it('takes the page URL and title from the top frame', () => {
    const state = createRuntimeState({ clock: () => 0 });
    state.ensureTab(1, 'https://site.test/watch');
    // The frame reports first, so "first seen" would pick the wrong one.
    state.setReport(1, frame('https://site.test/embed/abc', { documentTitle: 'embed' }));
    state.setReport(1, frame('https://site.test/watch', { documentTitle: 'Watch — Site' }));

    const merged = state.getReport(1);

    expect(merged?.pageUrl).toBe('https://site.test/watch');
    expect(merged?.documentTitle).toBe('Watch — Site');
  });

  it('merges observed resources across frames, without duplicates', () => {
    const state = createRuntimeState({ clock: () => 0 });
    state.ensureTab(1, 'https://site.test/watch');
    state.setReport(
      1,
      frame('https://site.test/watch', {
        observedResources: [{ url: 'https://cdn.test/a.txt', initiatorType: 'fetch' }],
      }),
    );
    state.setReport(
      1,
      frame('https://site.test/embed/abc', {
        observedResources: [
          { url: 'https://cdn.test/a.txt', initiatorType: 'fetch' },
          { url: 'https://cdn.test/b.txt', initiatorType: 'xmlhttprequest' },
        ],
      }),
    );

    expect(state.getReport(1)?.observedResources?.map((r) => r.url)).toStrictEqual([
      'https://cdn.test/a.txt',
      'https://cdn.test/b.txt',
    ]);
  });

  it('carries the frame count and embedded origins through the merge', () => {
    // A refresh runs from the MERGED report. A merge that dropped these would leave a
    // refresh unable to re-enter the frames — the exact moment a fresh grant needs it
    // to — and would leave the surface with no origin to offer (§8.10, §13.7).
    const state = createRuntimeState({ clock: () => 0 });
    state.ensureTab(1, 'https://site.test/watch');
    state.setReport(
      1,
      frame('https://site.test/watch', { frameCount: 1, frameOrigins: ['https://player.test'] }),
    );
    state.setReport(1, frame('https://player.test/e/abc', { frameOrigins: ['https://cdn.test'] }));

    const merged = state.getReport(1);
    expect(merged?.frameCount).toBe(1);
    expect(merged?.frameOrigins).toEqual(['https://player.test', 'https://cdn.test']);
  });

  it('replaces a frame when that same frame reports again', () => {
    const state = createRuntimeState({ clock: () => 0 });
    state.ensureTab(1, 'https://site.test/watch');
    state.setReport(
      1,
      frame('https://site.test/watch', { observedUrls: ['https://a.test/1.mp4'] }),
    );
    state.setReport(
      1,
      frame('https://site.test/watch', { observedUrls: ['https://a.test/2.mp4'] }),
    );

    expect(state.getReport(1)?.observedUrls).toStrictEqual(['https://a.test/2.mp4']);
    expect(state.getFrameReports(1)).toHaveLength(1);
  });

  it('bounds how many frames one tab may hold', () => {
    const state = createRuntimeState({ clock: () => 0 });
    state.ensureTab(1, 'https://site.test/watch');
    for (let index = 0; index < 40; index += 1) {
      state.setReport(1, frame(`https://site.test/frame/${String(index)}`));
    }
    // A page that creates frames endlessly must not grow this without limit (§10.9).
    expect(state.getFrameReports(1).length).toBeLessThanOrEqual(12);
  });

  it('forgets every frame when the tab is cleared', () => {
    const state = createRuntimeState({ clock: () => 0 });
    state.ensureTab(1, 'https://site.test/watch');
    state.setReport(1, frame('https://site.test/watch'));
    state.setReport(1, frame('https://site.test/embed/abc'));

    state.clearDetection(1);

    expect(state.getReport(1)).toBeUndefined();
    expect(state.getFrameReports(1)).toStrictEqual([]);
  });
});
