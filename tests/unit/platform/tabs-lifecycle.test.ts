import { describe, expect, it, vi } from 'vitest';
import { createTabsService } from '@platform/tabs/service';
import { createFakeWebExt } from './_fake-webext';

describe('tabs lifecycle extension', () => {
  it('forwards onCreated with normalized TabInfo', () => {
    const fake = createFakeWebExt();
    const tabs = createTabsService(fake.api);
    const seen = vi.fn();
    tabs.onCreated(seen);
    fake.onTabCreated.trigger({ id: 4, url: 'https://x.com', active: true, windowId: 1 });
    expect(seen).toHaveBeenCalledWith({ id: 4, url: 'https://x.com', active: true, windowId: 1 });
  });

  it('drops onCreated events for tabs without an id', () => {
    const fake = createFakeWebExt();
    const tabs = createTabsService(fake.api);
    const seen = vi.fn();
    tabs.onCreated(seen);
    fake.onTabCreated.trigger({ url: 'https://x.com' });
    expect(seen).not.toHaveBeenCalled();
  });

  it('forwards onRemoved / onAttached / onDetached tab ids', () => {
    const fake = createFakeWebExt();
    const tabs = createTabsService(fake.api);
    const removed = vi.fn();
    const attached = vi.fn();
    const detached = vi.fn();
    tabs.onRemoved(removed);
    tabs.onAttached(attached);
    tabs.onDetached(detached);
    fake.onTabRemoved.trigger(11, { windowId: 1, isWindowClosing: false });
    fake.onTabAttached.trigger(12, { newWindowId: 2, newPosition: 0 });
    fake.onTabDetached.trigger(13, { oldWindowId: 1, oldPosition: 3 });
    expect(removed).toHaveBeenCalledWith(11);
    expect(attached).toHaveBeenCalledWith(12);
    expect(detached).toHaveBeenCalledWith(13);
  });

  it('forwards onReplaced with added/removed ids', () => {
    const fake = createFakeWebExt();
    const tabs = createTabsService(fake.api);
    const replaced = vi.fn();
    tabs.onReplaced(replaced);
    fake.onTabReplaced.trigger(20, 19);
    expect(replaced).toHaveBeenCalledWith({ addedTabId: 20, removedTabId: 19 });
  });

  it('detaches the upstream listener when the last subscriber leaves (no leak)', () => {
    const fake = createFakeWebExt();
    const tabs = createTabsService(fake.api);
    const unsubscribe = tabs.onRemoved(vi.fn());
    expect(fake.onTabRemoved.size).toBe(1);
    unsubscribe();
    expect(fake.onTabRemoved.size).toBe(0);
  });
});
