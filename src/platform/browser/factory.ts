/**
 * Module: platform/browser (facade factory)
 * Purpose: Construct the {@link Browser} facade from a resolved WebExtension API
 *          (PROJECT_BIBLE.md §8.2). `createBrowser` auto-detects the target and is
 *          the composition entry point for runtime surfaces (Phase 3+).
 * Restrictions: Platform layer — wiring only. Both target factories share identical
 *          service logic; per-target divergence is captured by capabilities (§7.2).
 * Public API: createBrowser, createBrowserFrom, createChromiumBrowser,
 *          createFirefoxBrowser.
 */
import type { Browser } from '@platform/browser';
import { createActionService } from '@platform/browser/action/service';
import { detectCapabilities } from '@platform/browser/capabilities';
import { createI18nService } from '@platform/browser/i18n';
import { createRuntimeService } from '@platform/browser/runtime';
import { resolveWebExtApi, type PlatformTarget, type WebExtApi } from '@platform/browser/webext';
import { createDownloadsService } from '@platform/downloads/service';
import { createMenusService, resolveMenus } from '@platform/menus/service';
import { createMessageBus } from '@platform/messaging/service';
import { createNotificationsService } from '@platform/notifications/service';
import { createPermissionsService } from '@platform/permissions/service';
import { createScriptingService } from '@platform/scripting/service';
import { createStorageService } from '@platform/storage/service';
import { createTabsService } from '@platform/tabs/service';

/** Build the facade from an explicit API + target (used by tests and adapters). */
export function createBrowserFrom(api: WebExtApi, target: PlatformTarget): Browser {
  // The optional namespaces only exist once their optional permission is granted
  // (§13.3), so each adapter is constructed only when its namespace is present and
  // the facade leaves the member undefined otherwise (§7.2 graceful degradation).
  const menus = resolveMenus(api);
  return {
    target,
    capabilities: detectCapabilities(api, target),
    runtime: createRuntimeService(api, target),
    tabs: createTabsService(api),
    downloads: createDownloadsService(api),
    storage: createStorageService(api),
    permissions: createPermissionsService(api),
    messaging: createMessageBus(api),
    action: createActionService(api),
    scripting: createScriptingService(api),
    i18n: createI18nService(api),
    ...(menus !== undefined && { menus: createMenusService(menus) }),
    ...(api.notifications !== undefined && {
      notifications: createNotificationsService(api.notifications),
    }),
  };
}

/** Resolve the ambient namespace and build the facade (composition entry point). */
export function createBrowser(): Browser {
  const { api, target } = resolveWebExtApi();
  return createBrowserFrom(api, target);
}

/** Chromium adapter entry point (Chrome, Edge, Brave, Opera, Vivaldi). */
export function createChromiumBrowser(api: WebExtApi): Browser {
  return createBrowserFrom(api, 'chrome');
}

/** Firefox adapter entry point. */
export function createFirefoxBrowser(api: WebExtApi): Browser {
  return createBrowserFrom(api, 'firefox');
}
