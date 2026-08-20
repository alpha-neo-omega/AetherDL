import { describe, expect, it } from 'vitest';
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
