import { describe, expect, it, vi } from 'vitest';
import { createTabsService } from '@platform/tabs/service';
import { createFakeWebExt } from './_fake-webext';

describe('platform/tabs service', () => {
  it('reads the active tab and current window', async () => {
    const fake = createFakeWebExt();
    fake.setTabs([{ id: 5, url: 'https://ex.com', active: true, windowId: 1 }]);
    fake.setCurrentWindow({ id: 3, focused: true });
    const tabs = createTabsService(fake.api);

    const active = await tabs.getActive();
    expect(active).toEqual({ id: 5, url: 'https://ex.com', active: true, windowId: 1 });

    expect(await tabs.getCurrentWindow()).toEqual({ id: 3, focused: true });

    fake.setTabs([]);
    expect(await tabs.getActive()).toBeUndefined();
  });

  it('multiplexes activation events and detaches at zero', () => {
    const fake = createFakeWebExt();
    const tabs = createTabsService(fake.api);
    const listener = vi.fn();
    const off = tabs.onActivated(listener);
    expect(fake.onActivated.size).toBe(1);
    fake.onActivated.trigger({ tabId: 9, windowId: 1 });
    expect(listener).toHaveBeenCalledWith(9);
    off();
    expect(fake.onActivated.size).toBe(0);
  });

  it('shares one upstream onUpdated listener and filters navigations by URL', () => {
    const fake = createFakeWebExt();
    const tabs = createTabsService(fake.api);
    const updated = vi.fn();
    const navigated = vi.fn();
    const offA = tabs.onUpdated(updated);
    const offB = tabs.onNavigated(navigated);
    expect(fake.onUpdated.size).toBe(1);

    // status change, no URL change → onUpdated fires, onNavigated does not.
    fake.onUpdated.trigger(
      5,
      { status: 'complete' },
      { id: 5, url: 'https://ex.com', windowId: 1 },
    );
    expect(updated).toHaveBeenCalledTimes(1);
    expect(navigated).not.toHaveBeenCalled();

    // navigation to http(s) → onNavigated fires.
    fake.onUpdated.trigger(
      5,
      { url: 'https://new.com' },
      { id: 5, url: 'https://new.com', windowId: 1 },
    );
    expect(navigated).toHaveBeenCalledTimes(1);

    // navigation to a non-http(s) URL → filtered out (§13.5).
    fake.onUpdated.trigger(5, { url: 'about:blank' }, { id: 5, url: 'about:blank', windowId: 1 });
    expect(navigated).toHaveBeenCalledTimes(1);

    offA();
    offB();
    expect(fake.onUpdated.size).toBe(0);
  });
});
