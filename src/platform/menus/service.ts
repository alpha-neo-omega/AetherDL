/**
 * Module: platform/menus (implementation)
 * Purpose: Implement {@link MenusAdapter} over the normalized menu namespace —
 *          `chrome.contextMenus` on Chromium, `browser.menus` on Firefox
 *          (PROJECT_BIBLE.md §4.13, §7.4). The per-target difference lives here and
 *          nowhere else (§8.2).
 * Restrictions: Platform layer — adapts only. No decision about WHICH entries exist
 *          or when they are shown; that is the background's job (§8.2). The namespace
 *          is absent until the optional permission is granted and appears the moment
 *          it is, so it is resolved PER CALL: the adapter is constructed wherever the
 *          capability could exist, and `available()` tells the truth at the time of
 *          asking (§13.3, §7.2).
 * Public API: createMenusService, resolveMenus.
 */
import type { MenuItemSpec, MenusAdapter } from '@platform/menus';
import type { WebExtApi, WebExtMenus } from '@platform/browser/webext';
import { PlatformError } from '@shared/result/errors';
import { createMultiplexer } from '@shared/utils';

/** Menu failure. Category `capability`: the namespace may simply be unavailable. */
class MenusError extends PlatformError {
  readonly category = 'capability' as const;
}

/** The menu namespace for this target, or `undefined` when it is unavailable. */
export function resolveMenus(api: WebExtApi): WebExtMenus | undefined {
  return api.menus ?? api.contextMenus;
}

/**
 * Create the menus service. `resolve` is called per operation, so a namespace that
 * appears later (the user granting the optional permission) is picked up without a
 * restart.
 */
export function createMenusService(resolve: () => WebExtMenus | undefined): MenusAdapter {
  const clicks = createMultiplexer<[string]>((emit) => {
    const menus = resolve();
    if (menus === undefined) {
      // Nothing to attach to yet; the caller re-subscribes once the feature is
      // available, and an unsubscribe on this subscription is a no-op.
      return () => undefined;
    }
    const listener = (info: { menuItemId: string | number }): void => {
      emit(String(info.menuItemId));
    };
    menus.onClicked.addListener(listener);
    return () => {
      menus.onClicked.removeListener(listener);
    };
  });

  const require = (operation: string): WebExtMenus => {
    const menus = resolve();
    if (menus === undefined) {
      throw new MenusError(`Menu ${operation} is unavailable`, {
        code: 'menus-unavailable',
        messageKey: 'error.capability.menus',
      });
    }
    return menus;
  };

  const fail = (operation: string, cause: unknown): MenusError =>
    new MenusError(`Menu ${operation} failed`, {
      code: `menus-${operation}-failed`,
      messageKey: 'error.capability.menus',
      cause,
    });

  return {
    available(): boolean {
      return resolve() !== undefined;
    },

    create(spec: MenuItemSpec): Promise<void> {
      // Both engines take a completion callback; it is the only signal that the
      // entry actually landed, so the promise settles from it.
      return new Promise<void>((settle, reject) => {
        try {
          require('create').create(
            { id: spec.id, title: spec.title, contexts: [...spec.contexts] },
            () => {
              settle();
            },
          );
        } catch (cause) {
          reject(cause instanceof MenusError ? cause : fail('create', cause));
        }
      });
    },

    async remove(id: string): Promise<void> {
      try {
        await require('remove').remove(id);
      } catch (cause) {
        throw cause instanceof MenusError ? cause : fail('remove', cause);
      }
    },

    onClicked(listener: (id: string) => void): () => void {
      return clicks.subscribe(listener);
    },
  };
}
