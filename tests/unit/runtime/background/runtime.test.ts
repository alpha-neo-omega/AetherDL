import { describe, expect, it, vi } from 'vitest';
import { createBrowserFrom } from '@platform/browser/factory';
import { createMessageBus } from '@platform/messaging/service';
import { createBackgroundRuntime } from '@runtime/background/runtime';
import { createFakeWebExt, type FakeWebExt } from '../../platform/_fake-webext';
import { createFakeEngine, mediaItem, report, type FakeEngine } from '../_fixtures';

interface Harness {
  readonly fake: FakeWebExt;
  readonly engine: FakeEngine;
  readonly runtime: ReturnType<typeof createBackgroundRuntime>;
  readonly client: ReturnType<typeof createMessageBus>;
}

function setup(): Harness {
  const fake = createFakeWebExt();
  const browser = createBrowserFrom(fake.api, 'chrome');
  const engine = createFakeEngine();
  const runtime = createBackgroundRuntime({ browser, engine: engine.manager, clock: () => 1000 });
  runtime.start();
  const client = createMessageBus(fake.api);
  return { fake, engine, runtime, client };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('background detection runtime', () => {
  it('emits runtime:initialized on start', () => {
    const fake = createFakeWebExt();
    const browser = createBrowserFrom(fake.api, 'chrome');
    const engine = createFakeEngine();
    const runtime = createBackgroundRuntime({ browser, engine: engine.manager, clock: () => 42 });
    const initialized = vi.fn();
    runtime.on('runtime:initialized', initialized);
    runtime.start();
    expect(initialized).toHaveBeenCalledWith({ startedAt: 42 });
  });

  it('detection/run attributes to the active tab, detects, caches, and badges', async () => {
    const { fake, engine, runtime, client } = setup();
    fake.setTabs([{ id: 7, active: true, url: 'https://x.com/watch', windowId: 1 }]);
    engine.setItems([mediaItem({ id: 'a' }), mediaItem({ id: 'b', status: 'unsupported' })]);

    const items = await client.send('detection/run', report());
    await flush();

    expect(items).toHaveLength(2);
    expect(engine.contexts[0]?.tabId).toBe(7);
    expect(runtime.state.getItems(7)).toHaveLength(2);
    expect(runtime.state.getTab(7)?.itemCount).toBe(1); // only supported counts
    expect(fake.action.badgeText.get(7)).toBe('1');
  });

  it('detection/run returns nothing when there is no active tab', async () => {
    const { fake, engine, client } = setup();
    fake.setTabs([]);
    engine.setItems([mediaItem()]);
    const items = await client.send('detection/run', report());
    expect(items).toEqual([]);
  });

  it('detection/query returns a tab’s cached items', async () => {
    const { fake, engine, client } = setup();
    fake.setTabs([{ id: 3, active: true, windowId: 1 }]);
    engine.setItems([mediaItem({ id: 'x' })]);
    await client.send('detection/run', report());
    const queried = await client.send('detection/query', { tabId: 3 });
    expect(queried).toHaveLength(1);
    expect(queried[0]?.id).toBe('x');
  });

  it('detection/refresh invalidates the cache and re-runs on the stored report', async () => {
    const { fake, engine, client } = setup();
    fake.setTabs([{ id: 3, active: true, windowId: 1 }]);
    engine.setItems([mediaItem()]);
    await client.send('detection/run', report({ pageUrl: 'https://x.com/a' }));
    engine.setItems([mediaItem({ id: 'y' }), mediaItem({ id: 'z' })]);

    const refreshed = await client.send('detection/refresh', { tabId: 3 });
    expect(engine.invalidated).toContain(3);
    expect(refreshed).toHaveLength(2);
  });

  it('detection/refresh injects the content-script observer into the tab (§8.10)', async () => {
    const { fake, client } = setup();
    fake.setTabs([{ id: 3, active: true, url: 'https://x.com/a', windowId: 1 }]);

    await client.send('detection/refresh', { tabId: 3 });

    // The gesture-backed refresh is what puts the observer on the page; without it
    // the page is never observed and detection has nothing to work from.
    expect(fake.scripting.executed).toEqual([{ target: { tabId: 3 }, files: ['content.js'] }]);
  });

  it('detection/refresh survives a tab that cannot be injected', async () => {
    const { fake, runtime, engine, client } = setup();
    const errors: unknown[] = [];
    runtime.on('error', (error) => errors.push(error));
    fake.setTabs([{ id: 3, active: true, url: 'https://x.com/a', windowId: 1 }]);
    engine.setItems([mediaItem()]);
    await client.send('detection/run', report());
    const scripting = fake.api.scripting;
    if (scripting === undefined) {
      throw new Error('the fake namespace must expose scripting');
    }
    scripting.executeScript = (): Promise<never> =>
      Promise.reject(new Error('Cannot access a chrome:// URL'));

    const refreshed = await client.send('detection/refresh', { tabId: 3 });

    // A browser-UI tab yields no observations, but the refresh still answers from
    // what is known and the failure is reported, not thrown (§20.7).
    expect(refreshed).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it('never injects on query, run or clear — only the gesture-backed refresh does', async () => {
    const { fake, engine, client } = setup();
    fake.setTabs([{ id: 3, active: true, url: 'https://x.com/a', windowId: 1 }]);
    engine.setItems([mediaItem()]);

    await client.send('detection/run', report());
    await client.send('detection/query', { tabId: 3 });
    await client.send('detection/clear', { tabId: 3 });

    expect(fake.scripting.executed).toEqual([]);
  });

  it('detection/refresh with no stored report returns current items without re-running', async () => {
    const { client, engine } = setup();
    const result = await client.send('detection/refresh', { tabId: 99 });
    expect(result).toEqual([]);
    expect(engine.contexts).toHaveLength(0);
  });

  it('detection/clear invalidates, drops results, and clears the badge', async () => {
    const { fake, engine, runtime, client } = setup();
    fake.setTabs([{ id: 3, active: true, windowId: 1 }]);
    engine.setItems([mediaItem()]);
    await client.send('detection/run', report());
    await client.send('detection/clear', { tabId: 3 });
    await flush();
    expect(engine.invalidated).toContain(3);
    expect(runtime.state.getItems(3)).toEqual([]);
    expect(fake.action.badgeText.get(3)).toBe('');
  });

  it('emits detection:failed when the engine throws', async () => {
    const { fake, engine, runtime, client } = setup();
    fake.setTabs([{ id: 5, active: true, windowId: 1 }]);
    const failed = vi.fn();
    runtime.on('detection:failed', failed);
    engine.failNext();
    const items = await client.send('detection/run', report());
    expect(items).toEqual([]);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(runtime.state.getTab(5)?.status).toBe('failed');
  });

  it('switches the active tab and badges it on activation', async () => {
    const { fake, engine, runtime, client } = setup();
    fake.setTabs([{ id: 8, active: true, windowId: 1 }]);
    engine.setItems([mediaItem({ id: 'a' }), mediaItem({ id: 'b' })]);
    await client.send('detection/run', report());
    await flush();

    const changed = vi.fn();
    runtime.on('tab:changed', changed);
    fake.onActivated.trigger({ tabId: 8, windowId: 1 });
    await flush();
    expect(runtime.state.activeTabId()).toBe(8);
    expect(changed).toHaveBeenCalledWith({ tabId: 8 });
    expect(fake.action.badgeText.get(8)).toBe('2');
  });

  it('invalidates and clears on navigation', async () => {
    const { fake, engine, runtime, client } = setup();
    fake.setTabs([{ id: 4, active: true, windowId: 1 }]);
    engine.setItems([mediaItem()]);
    await client.send('detection/run', report());

    const navigation = vi.fn();
    runtime.on('navigation', navigation);
    fake.onUpdated.trigger(
      4,
      { url: 'https://x.com/next' },
      { id: 4, url: 'https://x.com/next', active: true, windowId: 1 },
    );
    await flush();
    expect(engine.invalidated).toContain(4);
    expect(runtime.state.getItems(4)).toEqual([]);
    expect(navigation).toHaveBeenCalledWith({ tabId: 4, url: 'https://x.com/next' });
  });

  it('cleans up runtime state and cache when a tab is removed', async () => {
    const { fake, engine, runtime, client } = setup();
    fake.setTabs([{ id: 6, active: true, windowId: 1 }]);
    engine.setItems([mediaItem()]);
    await client.send('detection/run', report());
    fake.onTabRemoved.trigger(6, { windowId: 1, isWindowClosing: false });
    expect(engine.invalidated).toContain(6);
    expect(runtime.state.getTab(6)).toBeUndefined();
  });

  it('handles tab replacement by swapping cache + state', () => {
    const { fake, engine, runtime } = setup();
    fake.onTabReplaced.trigger(20, 19);
    expect(engine.invalidated).toContain(19);
    expect(runtime.state.getTab(20)).toBeDefined();
  });

  it('forwards engine cache + media + error events on the single stream', () => {
    const { engine, runtime } = setup();
    const cacheHit = vi.fn();
    const media = vi.fn();
    const error = vi.fn();
    runtime.on('cache:hit', cacheHit);
    runtime.on('media:detected', media);
    runtime.on('error', error);
    engine.emitter.emit('cache:hit', { tabId: 1 });
    engine.emitter.emit('media:detected', mediaItem());
    engine.emitter.emit('error', {
      category: 'internal',
      code: 'x',
      messageKey: 'k',
      retryable: false,
    });
    expect(cacheHit).toHaveBeenCalledWith({ tabId: 1 });
    expect(media).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('registers created tabs, tracks updates, and treats detach as a no-op', () => {
    const { fake, runtime } = setup();
    fake.onTabCreated.trigger({ id: 10, url: 'https://x.com', active: false, windowId: 1 });
    expect(runtime.state.getTab(10)?.url).toBe('https://x.com');
    fake.onUpdated.trigger(10, {}, { id: 10, url: 'https://x.com/2', active: false, windowId: 1 });
    expect(runtime.state.getTab(10)?.url).toBe('https://x.com/2');
    fake.onTabDetached.trigger(10, { oldWindowId: 1, oldPosition: 0 });
    expect(runtime.state.getTab(10)).toBeDefined();
  });

  it('forwards detection:finished and cache:miss events', () => {
    const { engine, runtime } = setup();
    const finished = vi.fn();
    const miss = vi.fn();
    runtime.on('detection:finished', finished);
    runtime.on('cache:miss', miss);
    engine.emitter.emit('cache:miss', { tabId: 2 });
    engine.emitter.emit('detection:finished', {
      context: {
        tabId: 2,
        pageUrl: '',
        domSignals: [],
        observedUrls: [],
        source: 'dom',
        timestamp: 0,
      },
      items: [],
      fromCache: true,
    });
    expect(miss).toHaveBeenCalledWith({ tabId: 2 });
    expect(finished).toHaveBeenCalledWith({ tabId: 2, items: [], fromCache: true });
  });

  it('clears stale items + badge when a tab navigates to a non-http(s) URL', async () => {
    const { fake, engine, runtime, client } = setup();
    fake.setTabs([{ id: 4, active: true, windowId: 1 }]);
    engine.setItems([mediaItem()]);
    await client.send('detection/run', report());
    await flush();
    expect(runtime.state.getItems(4)).toHaveLength(1);

    // about:blank is not http(s); onNavigated would NOT fire, but onUpdated must clear.
    fake.onUpdated.trigger(4, {}, { id: 4, url: 'about:blank', active: true, windowId: 1 });
    await flush();
    expect(runtime.state.getItems(4)).toEqual([]);
    expect(fake.action.badgeText.get(4)).toBe('');
  });

  it('rejects a malformed detection/run payload without touching state (§13.8)', async () => {
    const { engine, runtime, client } = setup();
    const failed = vi.fn();
    runtime.on('detection:failed', failed);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = await client.send('detection/run', {} as any);
    expect(items).toEqual([]);
    expect(failed).not.toHaveBeenCalled();
    expect(runtime.state.tabs()).toHaveLength(0);
    expect(engine.contexts).toHaveLength(0);
  });

  it('ignores a non-numeric tabId on clear (no phantom tab, no global badge clear)', async () => {
    const { runtime, client } = setup();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.send('detection/clear', { tabId: 'x' as any });
    expect(runtime.state.tabs()).toHaveLength(0);
  });

  it('ignores a non-numeric tabId on refresh and query', async () => {
    const { client } = setup();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await client.send('detection/refresh', { tabId: 'x' as any })).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await client.send('detection/query', { tabId: 'x' as any })).toEqual([]);
  });

  it('suppresses a stale FAILED result when superseded mid-flight', async () => {
    const { fake, engine, runtime, client } = setup();
    fake.setTabs([{ id: 6, active: true, windowId: 1 }]);
    const failed = vi.fn();
    runtime.on('detection:failed', failed);
    engine.hold();
    engine.failNext();
    const pending = client.send('detection/run', report());
    await flush();
    fake.onUpdated.trigger(6, {}, { id: 6, url: 'https://x.com/next', active: true, windowId: 1 });
    engine.release();
    await pending;
    await flush();
    expect(failed).not.toHaveBeenCalled();
    expect(runtime.state.getItems(6)).toEqual([]);
  });

  it('does not let a stale in-flight run overwrite state after a navigation', async () => {
    const { fake, engine, runtime, client } = setup();
    fake.setTabs([{ id: 5, active: true, windowId: 1 }]);
    engine.setItems([mediaItem({ id: 'a' }), mediaItem({ id: 'b' })]);
    engine.hold();
    const pending = client.send('detection/run', report());
    await flush(); // handler is now suspended inside engine.detect

    // Navigate the tab while detection is in flight.
    fake.onUpdated.trigger(5, {}, { id: 5, url: 'https://x.com/next', active: true, windowId: 1 });
    engine.release();
    await pending;
    await flush();

    // The superseded run must NOT re-populate the cleared tab.
    expect(runtime.state.getItems(5)).toEqual([]);
    expect(fake.action.badgeText.get(5)).toBe('');
  });

  it('does not resurrect a tab removed while its detection run is in flight', async () => {
    const { fake, engine, runtime, client } = setup();
    fake.setTabs([{ id: 5, active: true, windowId: 1 }]);
    engine.setItems([mediaItem()]);
    engine.hold();
    const pending = client.send('detection/run', report());
    await flush();
    fake.onTabRemoved.trigger(5, { windowId: 1, isWindowClosing: true });
    engine.release();
    await pending;
    await flush();
    expect(runtime.state.getTab(5)).toBeUndefined();
  });

  it('tolerates a null clear payload without throwing or creating a phantom tab', async () => {
    const { runtime, client } = setup();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.send('detection/clear', null as any);
    expect(runtime.state.tabs()).toHaveLength(0);
  });

  it('start is idempotent and dispose is safe to call twice', async () => {
    const { runtime } = setup();
    runtime.start();
    await runtime.dispose();
    await expect(runtime.dispose()).resolves.toBeUndefined();
  });

  it('dispose detaches listeners and disposes the engine', async () => {
    const { fake, engine, runtime, client } = setup();
    await runtime.dispose();
    expect(engine.disposed()).toBe(true);
    // After dispose, a fresh activation must not change state.
    fake.onActivated.trigger({ tabId: 1, windowId: 1 });
    expect(runtime.state.activeTabId()).toBeUndefined();
    client.dispose();
  });
});
