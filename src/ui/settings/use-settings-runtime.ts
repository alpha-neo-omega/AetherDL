/**
 * Module: ui/settings (runtime data hook)
 * Purpose: Bind the settings surface to the background: load the catalogue, history
 *          and optional-permission state, apply validated changes, and stay in step
 *          with changes applied elsewhere (PROJECT_BIBLE.md §4.9, §4.11, §8.5).
 * Restrictions: UI layer — a VIEW over runtime state. It validates nothing itself
 *          (the core service is the authority), owns no domain state and never
 *          touches storage or a browser API (§8.7, §13.2). Rejected changes surface
 *          next to the field instead of being swallowed (§15.6). The subscription is
 *          released on unmount (§12.7).
 * Public API: SettingsStatus, SettingsRuntimeData, SettingsRuntimeActions,
 *          useSettingsRuntime.
 */
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import type { AppError } from '@shared/result';
import type { HistoryRecord, Settings } from '@shared/types';
import { toAppError } from '@ui/popup';
import type { OptionalPermission, SettingsRuntimeClient } from './runtime-client';

export type SettingsStatus = 'loading' | 'ready' | 'error';

export interface SettingsRuntimeData {
  readonly status: SettingsStatus;
  readonly settings: Settings | undefined;
  readonly history: readonly HistoryRecord[];
  readonly permissions: Readonly<Record<OptionalPermission, boolean>>;
  /** A failure that left the page with nothing to show (§11.5 error state). */
  readonly error: AppError | undefined;
  /** A recoverable failure shown alongside the form (§20.5). */
  readonly notice: AppError | undefined;
  /** True immediately after a change was accepted and persisted (§4.9). */
  readonly saved: boolean;
}

export interface SettingsRuntimeActions {
  reload(): void;
  update(patch: Partial<Settings>): void;
  reset(): void;
  deleteRecord(id: string): void;
  clearHistory(): void;
  exportHistory(filename: string): void;
  grant(permission: OptionalPermission): void;
  revoke(permission: OptionalPermission): void;
  dismissNotice(): void;
}

const PERMISSIONS: readonly OptionalPermission[] = ['notifications', 'contextMenus'];

type Action =
  | { readonly type: 'loading' }
  | {
      readonly type: 'loaded';
      readonly settings: Settings;
      readonly history: readonly HistoryRecord[];
      readonly permissions: Readonly<Record<OptionalPermission, boolean>>;
    }
  | { readonly type: 'settings'; readonly settings: Settings; readonly saved: boolean }
  | { readonly type: 'history'; readonly history: readonly HistoryRecord[] }
  | {
      readonly type: 'permission';
      readonly permission: OptionalPermission;
      readonly granted: boolean;
    }
  | { readonly type: 'failed'; readonly error: AppError }
  | { readonly type: 'notice'; readonly error: AppError }
  | { readonly type: 'dismiss' };

const INITIAL: SettingsRuntimeData = {
  status: 'loading',
  settings: undefined,
  history: [],
  permissions: { notifications: false, contextMenus: false },
  error: undefined,
  notice: undefined,
  saved: false,
};

function reducer(state: SettingsRuntimeData, action: Action): SettingsRuntimeData {
  switch (action.type) {
    case 'loading':
      return { ...state, status: 'loading', error: undefined };
    case 'loaded':
      return {
        ...state,
        status: 'ready',
        settings: action.settings,
        history: action.history,
        permissions: action.permissions,
        error: undefined,
      };
    case 'settings':
      return { ...state, settings: action.settings, saved: action.saved, notice: undefined };
    case 'history':
      return { ...state, history: action.history };
    case 'permission':
      return {
        ...state,
        permissions: { ...state.permissions, [action.permission]: action.granted },
      };
    case 'failed':
      return { ...state, status: 'error', error: action.error };
    case 'notice':
      return { ...state, notice: action.error, saved: false };
    case 'dismiss':
      return state.notice === undefined ? state : { ...state, notice: undefined };
    default:
      return state;
  }
}

async function readPermissions(
  client: SettingsRuntimeClient,
): Promise<Readonly<Record<OptionalPermission, boolean>>> {
  const entries = await Promise.all(
    PERMISSIONS.map(async (permission) => {
      // Never ask about a permission this browser cannot offer: the answer would
      // always be false and the question is meaningless there (§7.2).
      const granted = client.supportsPermission(permission)
        ? await client.hasPermission(permission)
        : false;
      return [permission, granted] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<OptionalPermission, boolean>;
}

export function useSettingsRuntime(
  client: SettingsRuntimeClient,
): SettingsRuntimeData & { readonly actions: SettingsRuntimeActions } {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const [reloadToken, setReloadToken] = useState(0);

  const fail = useCallback((cause: unknown): void => {
    dispatch({ type: 'notice', error: toAppError(cause) });
  }, []);

  const refreshHistory = useCallback((): void => {
    void client.queryHistory().then((history) => {
      dispatch({ type: 'history', history });
    }, fail);
  }, [client, fail]);

  useEffect(() => {
    let cancelled = false;
    dispatch({ type: 'loading' });
    void (async (): Promise<void> => {
      try {
        const settings = await client.getSettings();
        const history = await client.queryHistory();
        const permissions = await readPermissions(client);
        if (!cancelled) {
          dispatch({ type: 'loaded', settings, history, permissions });
        }
      } catch (cause) {
        if (!cancelled) {
          dispatch({ type: 'failed', error: toAppError(cause) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, reloadToken]);

  // A change applied from another surface (or from the background) lands here.
  useEffect(() => {
    const unsubscribe = client.onSettingsChanged((settings) => {
      dispatch({ type: 'settings', settings, saved: false });
    });
    return () => {
      unsubscribe();
    };
  }, [client]);

  const actions = useMemo<SettingsRuntimeActions>(
    () => ({
      reload: () => {
        setReloadToken((token) => token + 1);
      },
      update: (patch) => {
        void client.updateSettings(patch).then((settings) => {
          dispatch({ type: 'settings', settings, saved: true });
        }, fail);
      },
      reset: () => {
        void client.resetSettings().then((settings) => {
          dispatch({ type: 'settings', settings, saved: true });
        }, fail);
      },
      deleteRecord: (id) => {
        void client.deleteHistory(id).then(refreshHistory, fail);
      },
      clearHistory: () => {
        void client.clearHistory().then(refreshHistory, fail);
      },
      exportHistory: (filename) => {
        void client.exportHistory(filename).catch(fail);
      },
      grant: (permission) => {
        // Called straight from the click so the browser sees the user gesture (§13.3).
        void client.requestPermission(permission).then((granted) => {
          dispatch({ type: 'permission', permission, granted });
          if (!granted) {
            // A refusal is an outcome the user must see, not a silent no-op (§2.8).
            dispatch({
              type: 'notice',
              error: {
                category: 'permission',
                code: `permission-denied-${permission}`,
                messageKey: 'error.permission',
                retryable: false,
              },
            });
          }
        }, fail);
      },
      revoke: (permission) => {
        void client.removePermission(permission).then((removed) => {
          dispatch({ type: 'permission', permission, granted: !removed });
        }, fail);
      },
      dismissNotice: () => {
        dispatch({ type: 'dismiss' });
      },
    }),
    [client, fail, refreshHistory],
  );

  return { ...state, actions };
}
