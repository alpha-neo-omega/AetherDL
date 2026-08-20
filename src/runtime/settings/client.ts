/**
 * Module: runtime/settings (runtime client adapter)
 * Purpose: Implement the settings surface's {@link SettingsRuntimeClient} port over
 *          the platform facade (PROJECT_BIBLE.md §8.5, §11.2). Every form change
 *          becomes a typed message; optional permissions are requested here, in the
 *          page's own context, because both engines only honour a request made
 *          inside the user's gesture (§13.3).
 * Restrictions: Runtime layer — thin adaptation only; no validation, no storage and
 *          no domain logic (§8.1). It requests a permission only when the user asks
 *          for it, never pre-emptively (§13.1). The history export is written from
 *          memory to a local file: nothing is uploaded and the object URL is revoked
 *          straight after use (§14.3, §12.7).
 * Public API: createSettingsRuntimeClient.
 */
import type { Browser } from '@platform/browser';
import { SETTINGS_CHANGED_CHANNEL } from '@shared/constants';
import type { HistoryRecord, Settings } from '@shared/types';
import type { Unsubscribe } from '@shared/utils';
import type { OptionalPermission, SettingsRuntimeClient } from '@ui/settings';

/** Firefox names the menus permission `menus`; Chromium calls it `contextMenus`. */
function permissionName(browser: Browser, permission: OptionalPermission): string {
  if (permission === 'contextMenus') {
    return browser.target === 'firefox' ? 'menus' : 'contextMenus';
  }
  return permission;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A settings broadcast is trusted only once it carries the catalogue's shape. */
function asSettings(payload: unknown): Settings | undefined {
  return isRecord(payload) && typeof payload['theme'] === 'string'
    ? (payload as unknown as Settings)
    : undefined;
}

/** Save text to a local file through a transient object URL (§4.11 export). */
function saveLocalFile(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function createSettingsRuntimeClient(browser: Browser): SettingsRuntimeClient {
  const bus = browser.messaging;

  return {
    getSettings(): Promise<Settings> {
      return bus.send('settings/get', undefined);
    },

    updateSettings(patch: Partial<Settings>): Promise<Settings> {
      return bus.send('settings/update', patch);
    },

    resetSettings(): Promise<Settings> {
      return bus.send('settings/reset', undefined);
    },

    queryHistory(): Promise<readonly HistoryRecord[]> {
      return bus.send('history/query', undefined);
    },

    deleteHistory(id: string): Promise<void> {
      return bus.send('history/delete', { id });
    },

    clearHistory(): Promise<void> {
      return bus.send('history/clear', undefined);
    },

    async exportHistory(filename: string): Promise<void> {
      saveLocalFile(filename, await bus.send('history/export', undefined));
    },

    supportsPermission(permission: OptionalPermission): boolean {
      // What the running target's manifest declares as optional — the only honest
      // answer to "can the user grant this here?" (§7.2, §13.3).
      return browser.runtime
        .getManifest()
        .optionalPermissions.includes(permissionName(browser, permission));
    },

    hasPermission(permission: OptionalPermission): Promise<boolean> {
      return browser.permissions.contains([permissionName(browser, permission)]);
    },

    requestPermission(permission: OptionalPermission): Promise<boolean> {
      // Not awaited on anything first: the call must stay inside the user gesture.
      return browser.permissions.request([permissionName(browser, permission)]);
    },

    removePermission(permission: OptionalPermission): Promise<boolean> {
      return browser.permissions.remove([permissionName(browser, permission)]);
    },

    async listSiteAccess(): Promise<readonly string[]> {
      // Whatever the browser says is granted, sorted so the list does not reshuffle
      // between reads (§4.15, §13.7).
      const snapshot = await browser.permissions.getAll();
      return [...snapshot.origins].sort((left, right) => left.localeCompare(right));
    },

    revokeSiteAccess(origin: string): Promise<boolean> {
      return browser.permissions.removeHosts([origin]);
    },

    getVersion(): string {
      return browser.runtime.getVersion();
    },

    onSettingsChanged(listener: (settings: Settings) => void): Unsubscribe {
      return bus.onBroadcast(SETTINGS_CHANGED_CHANNEL, (payload) => {
        const settings = asSettings(payload);
        if (settings !== undefined) {
          listener(settings);
        }
      });
    },
  };
}
