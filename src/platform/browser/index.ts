/**
 * Module: platform/browser
 * Purpose: The single, typed platform facade aggregating the implemented browser
 *          services (PROJECT_BIBLE.md §8.2). This is the ONE interface the rest of
 *          the application depends on; nothing outside platform/ touches browser
 *          APIs directly (§8.4). Concrete construction lives in ./factory.
 * Restrictions: Platform layer — type-only module; depends only on sibling platform
 *          contracts (§8.4). No product logic.
 * Public API: PlatformTarget, Browser (+ re-exported service contract types).
 */
import type { ActionAdapter } from '@platform/browser/action';
import type { Capabilities } from '@platform/browser/capabilities';
import type { I18nService } from '@platform/browser/i18n';
import type { RuntimeService } from '@platform/browser/runtime';
import type { PlatformTarget } from '@platform/browser/webext';
import type { DownloadsAdapter } from '@platform/downloads';
import type { MenusAdapter } from '@platform/menus';
import type { MessageBus } from '@platform/messaging';
import type { NetworkObserver } from '@platform/network';
import type { NotificationsAdapter } from '@platform/notifications';
import type { PermissionsAdapter } from '@platform/permissions';
import type { ScriptingAdapter } from '@platform/scripting';
import type { StorageService } from '@platform/storage';
import type { TabsAdapter } from '@platform/tabs';

export type { PlatformTarget } from '@platform/browser/webext';

/**
 * The aggregated platform facade injected into composition roots (runtime/).
 *
 * The core services below are implemented in Phase 2; `action` and `scripting` are
 * ratified additive capabilities. The optional members are declared for later phases
 * and are intentionally absent in Phase 2 builds (per the Owner's phase scope);
 * consumers must feature-check them.
 */
export interface Browser {
  readonly target: PlatformTarget;
  readonly capabilities: Capabilities;
  readonly runtime: RuntimeService;
  readonly tabs: TabsAdapter;
  readonly downloads: DownloadsAdapter;
  readonly storage: StorageService;
  readonly permissions: PermissionsAdapter;
  readonly messaging: MessageBus;
  readonly action: ActionAdapter;
  readonly scripting: ScriptingAdapter;
  /** Message catalogue access (§19.1); degrades to empty lookups when absent. */
  readonly i18n: I18nService;
  readonly network?: NetworkObserver;
  /**
   * Present only when the matching optional permission has been granted, so the
   * namespace exists (§13.3). Consumers feature-check before use.
   */
  readonly notifications?: NotificationsAdapter;
  readonly menus?: MenusAdapter;
}
