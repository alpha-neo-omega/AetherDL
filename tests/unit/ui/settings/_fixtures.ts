/**
 * Test fixtures for the settings surface: a controllable fake of its runtime client
 * port. The fake sits exactly at the messaging/permission boundary, so the page is
 * exercised through the same contract the real adapter implements. Not a test file.
 */
import { act } from 'react';
import { DEFAULT_SETTINGS } from '@core/settings';
import type { HistoryRecord, Settings } from '@shared/types';
import type { OptionalPermission, SettingsRuntimeClient } from '@ui/settings';
import { validateSettingsPatch } from '@core/settings/validate';

export function historyRecord(
  props: Partial<HistoryRecord> & { readonly id: string },
): HistoryRecord {
  return {
    title: `Title ${props.id}`,
    kind: 'video',
    originHost: 'example.com',
    timestamp: 1_700_000_000_000,
    outcome: 'completed',
    filename: `${props.id}.mp4`,
    ...props,
  };
}

export interface FakeSettingsClient {
  readonly client: SettingsRuntimeClient;
  /** Calls made, in order, as `"<method>:<argument>"`. */
  readonly calls: string[];
  readonly granted: Set<OptionalPermission>;
  /** Set false to make the next request come back refused. */
  grantRequests: boolean;
  /** Optional permissions this fake browser can offer at all (§7.2). */
  supported: Set<OptionalPermission>;
  settings: Settings;
  history: readonly HistoryRecord[];
  /** Make the next call of a method reject. */
  failNext(method: string, error: unknown): void;
  /** Push an applied catalogue, as the background broadcasts it. */
  emitSettings(next: Settings): void;
  readonly subscriptions: { count: number };
}

export function createFakeSettingsClient(): FakeSettingsClient {
  const calls: string[] = [];
  const failures = new Map<string, unknown>();
  const listeners = new Set<(settings: Settings) => void>();
  const subscriptions = { count: 0 };

  const guard = <T>(method: string, argument: string, value: () => T): Promise<T> => {
    calls.push(argument === '' ? method : `${method}:${argument}`);
    if (failures.has(method)) {
      const error = failures.get(method);
      failures.delete(method);
      return Promise.reject(error);
    }
    try {
      return Promise.resolve(value());
    } catch (cause) {
      // A rejected setting must arrive as a rejected promise, exactly as the real
      // adapter delivers it over the message bus.
      return Promise.reject(cause);
    }
  };

  const fake: FakeSettingsClient = {
    calls,
    granted: new Set<OptionalPermission>(),
    // A Chromium-shaped browser by default: both permissions are offerable.
    supported: new Set<OptionalPermission>(['notifications', 'contextMenus']),
    grantRequests: true,
    settings: DEFAULT_SETTINGS,
    history: [],
    subscriptions,
    failNext(method: string, error: unknown): void {
      failures.set(method, error);
    },
    emitSettings(next: Settings): void {
      fake.settings = next;
      act(() => {
        for (const listener of [...listeners]) {
          listener(next);
        }
      });
    },
    client: {
      getSettings: () => guard('getSettings', '', () => fake.settings),
      updateSettings: (patch) =>
        guard('updateSettings', Object.keys(patch).join(','), () => {
          // The real service validates; the fake mirrors that so the page is
          // exercised against the same accept/reject behaviour.
          const validated = validateSettingsPatch(patch);
          if (!validated.ok) {
            throw validated.error;
          }
          fake.settings = { ...fake.settings, ...validated.value };
          return fake.settings;
        }),
      resetSettings: () =>
        guard('resetSettings', '', () => {
          fake.settings = DEFAULT_SETTINGS;
          return fake.settings;
        }),
      queryHistory: () => guard('queryHistory', '', () => fake.history),
      deleteHistory: (id) =>
        guard<void>('deleteHistory', id, () => {
          fake.history = fake.history.filter((record) => record.id !== id);
        }),
      clearHistory: () =>
        guard<void>('clearHistory', '', () => {
          fake.history = [];
        }),
      exportHistory: (filename) => guard<void>('exportHistory', filename, () => undefined),
      supportsPermission: (permission) => fake.supported.has(permission),
      hasPermission: (permission) =>
        guard('hasPermission', permission, () => fake.granted.has(permission)),
      requestPermission: (permission) =>
        guard('requestPermission', permission, () => {
          if (!fake.grantRequests) {
            return false;
          }
          fake.granted.add(permission);
          return true;
        }),
      removePermission: (permission) =>
        guard('removePermission', permission, () => fake.granted.delete(permission)),
      getVersion: () => '0.1.0',
      onSettingsChanged: (listener) => {
        listeners.add(listener);
        subscriptions.count += 1;
        return () => {
          listeners.delete(listener);
          subscriptions.count -= 1;
        };
      },
    },
  };
  return fake;
}
