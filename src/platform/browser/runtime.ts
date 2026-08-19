/**
 * Module: platform/browser (runtime service)
 * Purpose: Extension runtime lifecycle, identity, and info (PROJECT_BIBLE.md §8.9).
 *          Wraps runtime lifecycle hooks and manifest/version access.
 * Restrictions: Platform layer — adapts only; no domain logic. Listeners registered
 *          here return unsubscribe functions and detach cleanly (no leaks).
 * Public API: BrowserInfo, InstalledDetails, RuntimeService, createRuntimeService.
 */
import { readManifest, type AppManifest } from '@platform/browser/manifest';
import type { PlatformTarget, WebExtApi, WebExtInstalledDetails } from '@platform/browser/webext';
import type { Unsubscribe } from '@shared/utils';

export interface BrowserInfo {
  readonly name: string;
  readonly version: string;
  readonly target: PlatformTarget;
}

export interface InstalledDetails {
  readonly reason: string;
  readonly previousVersion: string | undefined;
}

export interface RuntimeService {
  readonly id: string | undefined;
  getManifest(): AppManifest;
  getVersion(): string;
  getURL(path: string): string;
  getBrowserInfo(): Promise<BrowserInfo>;
  onInstalled(listener: (details: InstalledDetails) => void): Unsubscribe;
  onStartup(listener: () => void): Unsubscribe;
}

/** Create the runtime service over a resolved WebExtension API. */
export function createRuntimeService(api: WebExtApi, target: PlatformTarget): RuntimeService {
  return {
    id: api.runtime.id,

    getManifest: () => readManifest(api),

    getVersion: () => readManifest(api).version,

    getURL: (path: string) => api.runtime.getURL(path),

    async getBrowserInfo(): Promise<BrowserInfo> {
      const getInfo = api.runtime.getBrowserInfo;
      if (typeof getInfo === 'function') {
        const info = await getInfo();
        return { name: info.name, version: info.version, target };
      }
      return {
        name: target === 'firefox' ? 'Firefox' : 'Chromium',
        version: readManifest(api).version,
        target,
      };
    },

    onInstalled(listener: (details: InstalledDetails) => void): Unsubscribe {
      const wrapped = (details: WebExtInstalledDetails): void => {
        listener({
          reason: details.reason ?? 'unknown',
          previousVersion: details.previousVersion,
        });
      };
      api.runtime.onInstalled.addListener(wrapped);
      return () => {
        api.runtime.onInstalled.removeListener(wrapped);
      };
    },

    onStartup(listener: () => void): Unsubscribe {
      api.runtime.onStartup.addListener(listener);
      return () => {
        api.runtime.onStartup.removeListener(listener);
      };
    },
  };
}
