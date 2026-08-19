/**
 * Module: platform/menus (implementation)
 * Purpose: Implement {@link MenusAdapter} over the normalized menu namespace —
 *          `chrome.contextMenus` on Chromium, `browser.menus` on Firefox
 *          (PROJECT_BIBLE.md §4.13, §7.4). The per-target difference lives here and
 *          nowhere else (§8.2).
 * Restrictions: Platform layer — adapts only. No decision about WHICH entries exist
 *          or when they are shown; that is the background's job (§8.2). The namespace
 *          is absent until the optional permission is granted, so the factory only
 *          constructs this adapter when the capability is present (§13.3).
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

/** Create the menus service over a resolved WebExtension API. */
export function createMenusService(menus: WebExtMenus): MenusAdapter {
  const clicks = createMultiplexer<[string]>((emit) => {
    const listener = (info: { menuItemId: string | number }): void => {
      emit(String(info.menuItemId));
    };
    menus.onClicked.addListener(listener);
    return () => {
      menus.onClicked.removeListener(listener);
    };
  });

  const fail = (operation: string, cause: unknown): MenusError =>
    new MenusError(`Menu ${operation} failed`, {
      code: `menus-${operation}-failed`,
      messageKey: 'error.capability.menus',
      cause,
    });

  return {
    create(spec: MenuItemSpec): Promise<void> {
      // Both engines take a completion callback; it is the only signal that the
      // entry actually landed, so the promise settles from it.
      return new Promise<void>((resolve, reject) => {
        try {
          menus.create({ id: spec.id, title: spec.title, contexts: [...spec.contexts] }, () => {
            resolve();
          });
        } catch (cause) {
          reject(fail('create', cause));
        }
      });
    },

    async remove(id: string): Promise<void> {
      try {
        await menus.remove(id);
      } catch (cause) {
        throw fail('remove', cause);
      }
    },

    onClicked(listener: (id: string) => void): () => void {
      return clicks.subscribe(listener);
    },
  };
}
