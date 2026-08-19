/**
 * Module: runtime/background/settings
 * Purpose: The background settings and history runtime (PROJECT_BIBLE.md §4.9,
 *          §4.11, §8.5) — it answers the `settings/*` and `history/*` messages over
 *          the existing typed bus, and announces an applied change so every open
 *          surface reflects it live.
 * Restrictions: Runtime layer — thin orchestration. Validation, defaults, retention
 *          and persistence all live in the core services; nothing is decided here
 *          (§8.1). Untrusted payloads are checked at the boundary (§13.8). History
 *          is local-only: the export is handed back to the calling surface and is
 *          never transmitted anywhere (§14.1, §14.3). Every handler is detached on
 *          dispose (§12.8).
 * Public API: HISTORY_EXPORT_VERSION, SettingsRuntimeEventMap,
 *          BackgroundSettingsRuntime, BackgroundSettingsRuntimeDeps,
 *          createBackgroundSettingsRuntime.
 */
import type { Browser } from '@platform/browser';
import type { HistoryService } from '@core/history';
import type { SettingsService } from '@core/settings';
import { SETTINGS_CHANGED_CHANNEL } from '@shared/constants';
import type { AppError } from '@shared/result';
import { PlatformError, RuntimeError } from '@shared/result/errors';
import type { HistoryRecord, Settings } from '@shared/types';
import { TypedEventEmitter, type Unsubscribe } from '@shared/utils';

/** Version stamped into an export so a future reader can interpret it (§4.11). */
export const HISTORY_EXPORT_VERSION = 1;

export type SettingsRuntimeEventMap = {
  /** An applied catalogue, after validation and persistence (§4.9). */
  readonly 'settings:changed': [Settings];
  readonly error: [AppError];
};

export interface BackgroundSettingsRuntime {
  start(): void;
  on<K extends keyof SettingsRuntimeEventMap>(
    event: K,
    listener: (...args: SettingsRuntimeEventMap[K]) => void,
  ): Unsubscribe;
  /** Entry point for the core services' storage failures (§20.7). */
  reportError(error: AppError): void;
  dispose(): void;
}

export interface BackgroundSettingsRuntimeDeps {
  readonly browser: Browser;
  readonly settings: SettingsService;
  readonly history: HistoryService;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Extract a non-empty record id from an untrusted payload (§13.8). */
function extractId(request: unknown): string | undefined {
  if (!isRecord(request)) {
    return undefined;
  }
  const id = request['id'];
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/** Serialize history for local export; pretty-printed so a human can read it. */
function toExport(records: readonly HistoryRecord[]): string {
  return `${JSON.stringify({ version: HISTORY_EXPORT_VERSION, records }, null, 2)}\n`;
}

export function createBackgroundSettingsRuntime(
  deps: BackgroundSettingsRuntimeDeps,
): BackgroundSettingsRuntime {
  const { browser, settings, history } = deps;
  const emitter = new TypedEventEmitter<SettingsRuntimeEventMap>();
  const unsubscribes: Unsubscribe[] = [];
  let started = false;
  let disposed = false;

  const report = (error: AppError): void => {
    emitter.emit('error', error);
  };

  /** Normalize a thrown value; a typed error keeps its own code (§20.4). */
  const toTypedError = (code: string, cause: unknown): PlatformError =>
    cause instanceof PlatformError
      ? cause
      : new RuntimeError('Background settings runtime error', {
          code,
          messageKey: 'error.runtime.settings',
          cause,
        });

  /** Report locally, then propagate so the surface sees an honest failure (§2.8). */
  const run = async <T>(code: string, operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (cause) {
      const error = toTypedError(code, cause);
      report(error.toAppError());
      throw error;
    }
  };

  /** Announce an applied catalogue locally and to every open surface (§12.4). */
  const announce = (applied: Settings): Settings => {
    emitter.emit('settings:changed', applied);
    void browser.messaging.broadcast(SETTINGS_CHANGED_CHANNEL, applied).catch(() => undefined);
    return applied;
  };

  return {
    start(): void {
      if (started) {
        return;
      }
      started = true;
      const bus = browser.messaging;
      unsubscribes.push(
        bus.on('settings/get', () => run('settings-get-failed', () => settings.get())),
        // A rejected patch propagates: the surface must see that nothing was saved
        // rather than a silent success (§2.8, §4.9).
        bus.on('settings/update', (patch) =>
          run('settings-update-failed', async () => announce(await settings.update(patch))),
        ),
        bus.on('settings/reset', () =>
          run('settings-reset-failed', async () => announce(await settings.reset())),
        ),
        bus.on('history/query', () => run('history-query-failed', () => history.list())),
        bus.on('history/delete', (request) =>
          run('history-delete-failed', async () => {
            const id = extractId(request);
            if (id !== undefined) {
              await history.delete(id);
            }
          }),
        ),
        bus.on('history/clear', () => run('history-clear-failed', () => history.clear())),
        bus.on('history/export', () =>
          run('history-export-failed', async () => toExport(await history.list())),
        ),
      );
    },

    on<K extends keyof SettingsRuntimeEventMap>(
      event: K,
      listener: (...args: SettingsRuntimeEventMap[K]) => void,
    ): Unsubscribe {
      return emitter.on(event, listener);
    },

    reportError: report,

    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
      unsubscribes.length = 0;
      emitter.clear();
    },
  };
}
