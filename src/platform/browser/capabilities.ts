/**
 * Module: platform/browser (capability detection / feature flags)
 * Purpose: Detect per-target browser capabilities so features degrade gracefully
 *          (PROJECT_BIBLE.md §7.2). Capabilities are the platform's feature flags.
 * Restrictions: Platform layer — depends only on the WebExtension normalization
 *          and shared/. No product logic.
 * Public API: Capabilities, detectCapabilities, isSupported.
 */
import type { PlatformTarget, WebExtApi } from '@platform/browser/webext';

export interface Capabilities {
  /** Both supported engines expose Promise-based MV3 APIs. */
  readonly promises: boolean;
  readonly sessionStorage: boolean;
  readonly syncStorage: boolean;
  readonly downloads: boolean;
  readonly permissions: boolean;
  readonly notifications: boolean;
  readonly contextMenus: boolean;
  readonly commands: boolean;
  readonly browserInfo: boolean;
}

/** Detect capabilities from the resolved API and target family. */
export function detectCapabilities(api: WebExtApi, target: PlatformTarget): Capabilities {
  return {
    promises: true,
    sessionStorage: api.storage.session !== undefined,
    syncStorage: api.storage.sync !== undefined,
    downloads: typeof api.downloads.download === 'function',
    permissions: typeof api.permissions.contains === 'function',
    notifications: api.notifications !== undefined,
    // Firefox exposes `menus`; Chromium exposes `contextMenus` (§7.4).
    contextMenus: target === 'firefox' ? api.menus !== undefined : api.contextMenus !== undefined,
    commands: api.commands !== undefined,
    browserInfo: typeof api.runtime.getBrowserInfo === 'function',
  };
}

/** Convenience predicate over a capabilities object. */
export function isSupported(capabilities: Capabilities, feature: keyof Capabilities): boolean {
  return capabilities[feature];
}
