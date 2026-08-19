/**
 * Module: runtime/background/contextmenu
 * Purpose: Context-menu wiring (PROJECT_BIBLE.md §4.13): entries on media elements
 *          and media links that enqueue the corresponding detected `MediaItem`.
 * Restrictions: Thin surface — delegates to platform/menus and the background
 *          download runtime; no domain logic (§8.1). DOUBLY GATED: the feature is
 *          off unless the user enabled it AND the optional `contextMenus`/`menus`
 *          permission is granted, and it never requests that permission itself
 *          (§4.13, §13.1, §13.3). Protected media is never offered, because only
 *          supported items are listed (§6.3). Every entry and listener is removed on
 *          dispose (§12.8).
 * Public API: MENU_ID_PREFIX, MAX_MENU_ENTRIES, ContextMenuRuntime,
 *          ContextMenuRuntimeDeps, createContextMenuRuntime.
 */
import type { Browser } from '@platform/browser';
import type { AppError } from '@shared/result';
import { PlatformError, RuntimeError } from '@shared/result/errors';
import type { MediaItem, Settings } from '@shared/types';
import type { Unsubscribe } from '@shared/utils';

/** Entry ids carry the media identity key, so a click maps straight to an item. */
export const MENU_ID_PREFIX = 'aetherdl:download:';

/** Upper bound on entries so a media-heavy page cannot flood the menu (§12). */
export const MAX_MENU_ENTRIES = 8;

/** The contexts an entry appears in: media elements and media links (§4.13). */
const MENU_CONTEXTS: readonly string[] = ['video', 'audio', 'link'];

/** The optional permission the feature needs, per target (§7.4, §13.3). */
const PERMISSION_BY_TARGET: Readonly<Record<string, string>> = {
  firefox: 'menus',
  chrome: 'contextMenus',
};

export interface ContextMenuRuntime {
  start(): void;
  /** Reconcile the menu with the current setting, permission and detected media. */
  sync(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ContextMenuRuntimeDeps {
  readonly browser: Browser;
  /** Reads the live catalogue; the entry set follows the `contextMenu` setting. */
  readonly getSettings: () => Promise<Settings>;
  /** Supported media detected for the tab the user is looking at (§8.7). */
  readonly getActiveItems: () => readonly MediaItem[];
  /** Hands the chosen item to the background download runtime (§4.13). */
  readonly enqueue: (itemIds: readonly string[]) => Promise<void>;
  readonly onError: (error: AppError) => void;
  /** Title shown on each entry, already localized by the composition root (§19.1). */
  readonly entryTitle: (item: MediaItem) => string;
}

function toAppError(code: string, cause: unknown): AppError {
  return cause instanceof PlatformError
    ? cause.toAppError()
    : new RuntimeError('Context menu error', {
        code,
        messageKey: 'error.runtime.contextmenu',
        cause,
      }).toAppError();
}

export function createContextMenuRuntime(deps: ContextMenuRuntimeDeps): ContextMenuRuntime {
  const { browser } = deps;
  /** Entry ids currently registered, so reconciliation is exact. */
  const present = new Set<string>();
  let unsubscribe: Unsubscribe | undefined;
  let started = false;
  let disposed = false;

  const permissionName = PERMISSION_BY_TARGET[browser.target] ?? 'contextMenus';

  /**
   * The feature is available only when the platform exposes the namespace AND the
   * optional permission is still granted. The permission is never requested here:
   * that happens at point-of-use in Settings, on a user gesture (§13.3).
   */
  const isAvailable = async (): Promise<boolean> => {
    if (browser.menus === undefined) {
      return false;
    }
    try {
      return await browser.permissions.contains([permissionName]);
    } catch (cause) {
      deps.onError(toAppError('contextmenu-permission-check-failed', cause));
      return false;
    }
  };

  const removeAll = async (): Promise<void> => {
    const menus = browser.menus;
    if (menus === undefined) {
      present.clear();
      return;
    }
    for (const id of [...present]) {
      present.delete(id);
      try {
        await menus.remove(id);
      } catch (cause) {
        deps.onError(toAppError('contextmenu-remove-failed', cause));
      }
    }
  };

  const sync = async (): Promise<void> => {
    if (disposed) {
      return;
    }
    const menus = browser.menus;
    let enabled = false;
    try {
      enabled = (await deps.getSettings()).contextMenu;
    } catch (cause) {
      deps.onError(toAppError('contextmenu-settings-failed', cause));
    }
    if (menus === undefined || !enabled || !(await isAvailable())) {
      await removeAll();
      return;
    }

    // Only supported media is offered; protected items are never downloadable (§6.3).
    const wanted = deps
      .getActiveItems()
      .filter((item) => item.status === 'supported')
      .slice(0, MAX_MENU_ENTRIES);
    const wantedIds = new Set(wanted.map((item) => `${MENU_ID_PREFIX}${item.id}`));

    for (const id of [...present]) {
      if (!wantedIds.has(id)) {
        present.delete(id);
        try {
          await menus.remove(id);
        } catch (cause) {
          deps.onError(toAppError('contextmenu-remove-failed', cause));
        }
      }
    }
    for (const item of wanted) {
      const id = `${MENU_ID_PREFIX}${item.id}`;
      if (present.has(id)) {
        continue;
      }
      try {
        await menus.create({ id, title: deps.entryTitle(item), contexts: MENU_CONTEXTS });
        present.add(id);
      } catch (cause) {
        deps.onError(toAppError('contextmenu-create-failed', cause));
      }
    }
  };

  return {
    start(): void {
      if (started || browser.menus === undefined) {
        return;
      }
      started = true;
      unsubscribe = browser.menus.onClicked((id) => {
        if (!id.startsWith(MENU_ID_PREFIX)) {
          return;
        }
        const itemId = id.slice(MENU_ID_PREFIX.length);
        void deps.enqueue([itemId]).catch((cause: unknown) => {
          deps.onError(toAppError('contextmenu-enqueue-failed', cause));
        });
      });
    },

    sync,

    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribe?.();
      unsubscribe = undefined;
      await removeAll();
    },
  };
}
