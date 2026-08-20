/**
 * Module: ui/settings (runtime client port)
 * Purpose: The boundary the settings surface talks to — the approved `settings/*`
 *          and `history/*` messages, plus the optional-permission operations that
 *          must run in the page's own user-gesture context (PROJECT_BIBLE.md §8.5,
 *          §13.3). This is a PORT: `runtime/settings` injects the concrete adapter
 *          (dependency inversion, §8.4 rule 3).
 * Restrictions: UI layer — declares intent only. No detection, no download, no
 *          storage and no browser access here; every member maps onto a contract
 *          that already exists. Types come from the leaf `shared/` layer, so this
 *          file imports nothing from platform/ or runtime/.
 * Public API: OptionalPermission, SettingsRuntimeClient, SettingsClientProvider,
 *          useSettingsClient.
 */
import { createContext, createElement, useContext, type ReactNode } from 'react';
import type { HistoryRecord, Settings } from '@shared/types';
import type { Unsubscribe } from '@shared/utils';

/**
 * The optional permissions AetherDL may request, at point-of-use only (§13.3).
 * The per-target name (`contextMenus` vs `menus`) is resolved by the adapter (§7.4).
 */
export type OptionalPermission = 'notifications' | 'contextMenus';

export interface SettingsRuntimeClient {
  /** `settings/get` — the catalogue with normative defaults applied (§4.9). */
  getSettings(): Promise<Settings>;
  /** `settings/update` — rejects the whole patch if any value is invalid (§4.9). */
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  /** `settings/reset` — restore every normative default (§4.9). */
  resetSettings(): Promise<Settings>;
  /** `history/query` — local records, newest first (§4.11). */
  queryHistory(): Promise<readonly HistoryRecord[]>;
  /** `history/delete` — remove one record (§4.11). */
  deleteHistory(id: string): Promise<void>;
  /** `history/clear` — erase everything (§14.4). */
  clearHistory(): Promise<void>;
  /** `history/export` then save locally; the payload never leaves the device. */
  exportHistory(filename: string): Promise<void>;
  /** Whether an optional permission is currently granted (§4.15). */
  /**
   * Whether this browser can offer the permission at all. A target that does not
   * declare it optionally can never grant it, so the surface must not present a
   * control for it (§7.2 graceful degradation, §13.3 least privilege).
   */
  supportsPermission(permission: OptionalPermission): boolean;
  hasPermission(permission: OptionalPermission): Promise<boolean>;
  /**
   * Request an optional permission. MUST be called straight from the user's click:
   * both engines only honour a request made inside that gesture (§13.3).
   */
  requestPermission(permission: OptionalPermission): Promise<boolean>;
  /** Give an optional permission back (§4.15). */
  removePermission(permission: OptionalPermission): Promise<boolean>;
  /**
   * The site origins the user has granted (§4.15). Stream downloads ask for these at
   * point of use, so they are the most consequential grants AetherDL holds — and a
   * grant the user cannot see is a grant the user cannot withdraw.
   */
  listSiteAccess(): Promise<readonly string[]>;
  /** Withdraw one granted origin. */
  revokeSiteAccess(origin: string): Promise<boolean>;
  /** Extension version, for the About section. */
  getVersion(): string;
  /** Applied settings pushed by the background so open surfaces stay in step. */
  onSettingsChanged(listener: (settings: Settings) => void): Unsubscribe;
}

const SettingsClientContext = createContext<SettingsRuntimeClient | undefined>(undefined);

export interface SettingsClientProviderProps {
  readonly client: SettingsRuntimeClient;
  readonly children: ReactNode;
}

export function SettingsClientProvider(props: SettingsClientProviderProps): ReactNode {
  return createElement(SettingsClientContext.Provider, { value: props.client }, props.children);
}

/** Read the injected client. Throws when the surface was not composed correctly. */
export function useSettingsClient(): SettingsRuntimeClient {
  const client = useContext(SettingsClientContext);
  if (client === undefined) {
    throw new Error('useSettingsClient must be used inside a SettingsClientProvider');
  }
  return client;
}
