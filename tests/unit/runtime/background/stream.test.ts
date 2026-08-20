/**
 * Choosing how this engine assembles (PROJECT_BIBLE.md §10.6, §7.2, §7.4). The
 * decision must be a capability check, never a browser-name check: a context that
 * can make object URLs assembles in place; a Chromium service worker delegates to
 * the offscreen document; anything else gets nothing and streams stay refused.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Browser } from '@platform/browser';
import type { StreamDeliveryAdapter } from '@platform/stream';
import { resolveStreamDelivery } from '@runtime/background/stream';

const scope = globalThis as unknown as {
  URL: { createObjectURL?: unknown; revokeObjectURL?: unknown };
};
const originalCreate = scope.URL.createObjectURL;
const originalRevoke = scope.URL.revokeObjectURL;

function withObjectUrls(available: boolean): void {
  if (available) {
    scope.URL.createObjectURL = (): string => 'blob:aetherdl/1';
    scope.URL.revokeObjectURL = (): void => undefined;
    return;
  }
  delete scope.URL.createObjectURL;
  delete scope.URL.revokeObjectURL;
}

function browserWith(stream?: StreamDeliveryAdapter): Browser {
  return { ...(stream !== undefined && { stream }) } as unknown as Browser;
}

const offscreenClient: StreamDeliveryAdapter = {
  supported: true,
  handles: () => true,
  assemble: () => Promise.reject(new Error('not called in this test')),
};

afterEach(() => {
  scope.URL.createObjectURL = originalCreate;
  scope.URL.revokeObjectURL = originalRevoke;
});

describe('resolveStreamDelivery', () => {
  it('assembles in place where object URLs exist (a Firefox event page)', () => {
    withObjectUrls(true);

    const delivery = resolveStreamDelivery(browserWith());

    expect(delivery?.supported).toBe(true);
    expect(delivery?.handles('https://cdn.test/a.m3u8')).toBe(true);
    expect(delivery?.handles('https://cdn.test/a.mp4')).toBe(false);
  });

  it('prefers assembling in place even when an offscreen client is also present', () => {
    withObjectUrls(true);

    const delivery = resolveStreamDelivery(browserWith(offscreenClient));

    // The in-process adapter refuses a non-manifest URL; the stub client accepts
    // everything, so this distinguishes which one was chosen.
    expect(delivery?.handles('https://cdn.test/a.mp4')).toBe(false);
  });

  it('delegates to the offscreen client in a service worker', () => {
    withObjectUrls(false);

    const delivery = resolveStreamDelivery(browserWith(offscreenClient));

    expect(delivery).toBe(offscreenClient);
  });

  it('resolves to nothing when neither route exists, leaving streams refused', () => {
    withObjectUrls(false);

    expect(resolveStreamDelivery(browserWith())).toBeUndefined();
  });

  it('ignores an offscreen client that reports itself unsupported', () => {
    withObjectUrls(false);

    const delivery = resolveStreamDelivery(browserWith({ ...offscreenClient, supported: false }));

    expect(delivery).toBeUndefined();
  });
});
