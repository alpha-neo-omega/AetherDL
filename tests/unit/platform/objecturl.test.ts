/**
 * The object-URL adapter (PROJECT_BIBLE.md §10.6, §8.2). It is the only place a
 * `blob:` URL is created or revoked, and it must report honestly that a Chromium MV3
 * service worker cannot create one at all rather than throwing at use time (§7.2).
 */
import { describe, expect, it, vi } from 'vitest';
import { createObjectUrlAdapter } from '@platform/objecturl/service';

interface FakeBlob {
  readonly parts: readonly unknown[];
  readonly type: string;
  readonly size: number;
}

function fakeGlobals(): {
  readonly globals: Parameters<typeof createObjectUrlAdapter>[0];
  readonly created: FakeBlob[];
  readonly revoked: string[];
} {
  const created: FakeBlob[] = [];
  const revoked: string[] = [];
  const Blob = function (this: FakeBlob, parts: readonly unknown[], options?: { type?: string }) {
    const size = parts.reduce<number>(
      (total, part) => total + ((part as Uint8Array).byteLength ?? 0),
      0,
    );
    const blob: FakeBlob = { parts, type: options?.type ?? '', size };
    created.push(blob);
    return blob;
  } as unknown as typeof globalThis.Blob;

  return {
    created,
    revoked,
    globals: {
      Blob,
      URL: {
        createObjectURL: (blob: Blob): string =>
          `blob:chrome-extension://aetherdl/${String((blob as unknown as FakeBlob).size)}`,
        revokeObjectURL: (url: string): void => {
          revoked.push(url);
        },
      },
    },
  };
}

describe('object URLs where the context supports them', () => {
  it('builds one blob from the parts, in order, and hands back a URL', () => {
    const { globals, created } = fakeGlobals();
    const adapter = createObjectUrlAdapter(globals);

    const handle = adapter.create([new Uint8Array(4), new Uint8Array(6)], 'video/mp2t');

    expect(adapter.supported).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]?.type).toBe('video/mp2t');
    expect(created[0]?.parts).toHaveLength(2);
    expect(handle.byteLength).toBe(10);
    expect(handle.url).toContain('blob:');
  });

  it('revokes on release, and only once', () => {
    const { globals, revoked } = fakeGlobals();
    const handle = createObjectUrlAdapter(globals).create([new Uint8Array(2)], 'video/mp4');

    handle.release();
    handle.release();

    expect(revoked).toEqual([handle.url]);
  });
});

describe('object URLs where the context does not support them', () => {
  it('reports unsupported instead of pretending, and refuses to create', () => {
    // What a Chromium MV3 service worker looks like: no createObjectURL.
    const adapter = createObjectUrlAdapter({ Blob: globalThis.Blob, URL: {} });

    expect(adapter.supported).toBe(false);
    expect(() => adapter.create([new Uint8Array(1)], 'video/mp4')).toThrow(/not available/i);
  });

  it('treats a missing Blob constructor the same way', () => {
    const revoke = vi.fn();
    const adapter = createObjectUrlAdapter({
      URL: { createObjectURL: () => 'blob:x', revokeObjectURL: revoke },
    });

    expect(adapter.supported).toBe(false);
    expect(() => adapter.create([], 'video/mp4')).toThrow();
    expect(revoke).not.toHaveBeenCalled();
  });
});
