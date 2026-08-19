import { describe, expect, it, vi } from 'vitest';
import type { ActionAdapter } from '@platform/browser/action';
import { createBadgeController } from '@runtime/background/badge';

function fakeAction(overrides: Partial<ActionAdapter> = {}): {
  action: ActionAdapter;
  text: Map<number, string>;
  colorCalls: number;
} {
  const text = new Map<number, string>();
  let colorCalls = 0;
  const action: ActionAdapter = {
    setBadgeText: async (value: string, tabId?: number) => {
      if (tabId !== undefined) {
        text.set(tabId, value);
      }
    },
    setBadgeBackgroundColor: async () => {
      colorCalls += 1;
    },
    setTitle: async () => undefined,
    enable: async () => undefined,
    disable: async () => undefined,
    ...overrides,
  };
  return {
    action,
    text,
    get colorCalls() {
      return colorCalls;
    },
  };
}

describe('badge controller', () => {
  it('shows the count and sets the background color for a non-empty badge', async () => {
    const fake = fakeAction();
    const badge = createBadgeController({ action: fake.action });
    await badge.set(7, 3);
    expect(fake.text.get(7)).toBe('3');
    expect(fake.colorCalls).toBe(1);
  });

  it('shows no badge (empty text) for a zero count (§4.7)', async () => {
    const fake = fakeAction();
    const badge = createBadgeController({ action: fake.action });
    await badge.set(7, 0);
    expect(fake.text.get(7)).toBe('');
  });

  it('coalesces repeat writes of the same value (flicker-free)', async () => {
    let writes = 0;
    const fake = fakeAction({
      setBadgeText: async () => {
        writes += 1;
      },
    });
    const badge = createBadgeController({ action: fake.action });
    await badge.set(7, 2);
    await badge.set(7, 2);
    await badge.set(7, 2);
    expect(writes).toBe(1);
  });

  it('surfaces write failures via onError without throwing (§20.7)', async () => {
    const onError = vi.fn();
    const fake = fakeAction({
      setBadgeText: async () => {
        throw new Error('tab gone');
      },
    });
    const badge = createBadgeController({ action: fake.action, onError });
    await expect(badge.set(7, 1)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('clear empties the badge and forgets the cached value', async () => {
    const fake = fakeAction();
    const badge = createBadgeController({ action: fake.action });
    await badge.set(7, 5);
    await badge.clear(7);
    expect(fake.text.get(7)).toBe('');
  });

  it('forget drops the cached value without a write, so the next set re-writes', async () => {
    let writes = 0;
    const fake = fakeAction({
      setBadgeText: async () => {
        writes += 1;
      },
    });
    const badge = createBadgeController({ action: fake.action });
    await badge.set(7, 3);
    await badge.set(7, 3); // coalesced
    badge.forget(7); // no write
    await badge.set(7, 3); // re-writes since the cache was forgotten
    expect(writes).toBe(2);
  });
});
