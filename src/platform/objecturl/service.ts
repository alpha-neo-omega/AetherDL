/**
 * Module: platform/objecturl (implementation)
 * Purpose: Implement {@link ObjectUrlAdapter} over the ambient `Blob`/`URL` globals
 *          (PROJECT_BIBLE.md §8.2, §10.6).
 * Restrictions: Platform layer — the ONLY place object URLs are created or revoked.
 *          `URL.createObjectURL` is absent in a Chromium MV3 service worker, so the
 *          adapter reports `supported: false` there rather than throwing at use time
 *          (§7.2 graceful degradation); that target routes through platform/stream's
 *          offscreen client instead.
 * Dependencies: shared/result (errors).
 * Public API: createObjectUrlAdapter.
 */
import { RuntimeError } from '@shared/result/errors';
import type { ObjectUrlAdapter, ObjectUrlHandle } from '@platform/objecturl';

interface ObjectUrlGlobals {
  readonly Blob?: typeof Blob;
  readonly URL?: {
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
  };
}

/**
 * @param globals Injected for tests; defaults to the ambient context.
 */
export function createObjectUrlAdapter(globals?: ObjectUrlGlobals): ObjectUrlAdapter {
  const scope: ObjectUrlGlobals = globals ?? (globalThis as unknown as ObjectUrlGlobals);
  const supported =
    typeof scope.Blob === 'function' &&
    typeof scope.URL?.createObjectURL === 'function' &&
    typeof scope.URL.revokeObjectURL === 'function';

  return {
    supported,
    create(parts: readonly Uint8Array[], mimeType: string): ObjectUrlHandle {
      if (!supported || scope.Blob === undefined || scope.URL?.createObjectURL === undefined) {
        throw new RuntimeError('Object URLs are not available in this context', {
          code: 'objecturl-unsupported',
          messageKey: 'error.runtime',
        });
      }
      // Copy nothing: Blob takes the views as they are. The browser owns the storage
      // from here, which is what keeps a large stream off the JS heap.
      const blob = new scope.Blob([...parts] as BlobPart[], { type: mimeType });
      const url = scope.URL.createObjectURL(blob);
      let released = false;
      return {
        url,
        byteLength: blob.size,
        release(): void {
          if (released) {
            return;
          }
          released = true;
          scope.URL?.revokeObjectURL?.(url);
        },
      };
    },
  };
}
