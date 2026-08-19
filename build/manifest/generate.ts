/**
 * Module: build/manifest (generator)
 * Purpose: Generate a per-target MV3 manifest from a single shared source
 *          (PROJECT_BIBLE.md §7.6 manifest generation, §7.5 MV3 strategy).
 * Responsibilities: Produce a valid, strict-CSP, least-privilege MV3 manifest for
 *          Chromium and Firefox from the same base definition.
 * Restrictions: Build tooling only; declares no host permissions (§13.7); encodes
 *          the strict CSP of §13.2. Content scripts are injected programmatically
 *          in later phases, so none are declared here (avoids standing host access).
 * Public API: Manifest, generateManifest.
 */
import {
  BASELINE_PERMISSIONS,
  FIREFOX_ADDON_ID,
  FIREFOX_DATA_COLLECTION_PERMISSIONS,
  FIREFOX_MIN_VERSION,
  optionalPermissionsFor,
  type BuildContext,
} from './targets';

interface IconSet {
  readonly [size: string]: string;
}

interface ActionSpec {
  readonly default_title: string;
  readonly default_popup: string;
  readonly default_icon: IconSet;
}

interface OptionsSpec {
  readonly page: string;
  readonly open_in_tab: boolean;
}

interface CspSpec {
  readonly extension_pages: string;
}

interface CommandSpec {
  readonly suggested_key: { readonly default: string; readonly mac: string };
  readonly description: string;
}

interface BackgroundSpec {
  readonly service_worker?: string;
  readonly scripts?: readonly string[];
  readonly type: 'module';
}

interface DataCollectionPermissions {
  /** Collected data categories; `['none']` declares that nothing is collected. */
  readonly required: readonly string[];
}

interface GeckoSettings {
  readonly gecko: {
    readonly id: string;
    readonly strict_min_version: string;
    /** AMO data-collection disclosure (§14.1, §14.3) — Firefox only. */
    readonly data_collection_permissions: DataCollectionPermissions;
  };
}

export interface Manifest {
  readonly manifest_version: 3;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly default_locale: string;
  readonly icons: IconSet;
  readonly action: ActionSpec;
  readonly options_ui: OptionsSpec;
  readonly background: BackgroundSpec;
  readonly permissions: readonly string[];
  readonly optional_permissions: readonly string[];
  readonly content_security_policy: CspSpec;
  readonly commands: Readonly<Record<string, CommandSpec>>;
  readonly browser_specific_settings?: GeckoSettings;
}

const ICONS: IconSet = {
  '16': 'icons/icon-16.png',
  '32': 'icons/icon-32.png',
  '48': 'icons/icon-48.png',
  '128': 'icons/icon-128.png',
};

/** Strict MV3 CSP for extension pages (PROJECT_BIBLE.md §13.2). */
const CSP = "script-src 'self'; object-src 'none'";

/**
 * Keyboard commands (PROJECT_BIBLE.md §4.14). `_execute_action` is the reserved MV3
 * command that opens the popup; the browser routes it itself, so no background
 * listener is involved. The binding avoids common browser shortcuts on both
 * platforms and needs no permission.
 */
const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  _execute_action: {
    suggested_key: { default: 'Ctrl+Shift+Y', mac: 'Command+Shift+Y' },
    description: '__MSG_commandOpenPopup__',
  },
};

/** Build the per-target background specification (PROJECT_BIBLE.md §7.4). */
function backgroundFor(target: BuildContext['target']): BackgroundSpec {
  if (target === 'firefox') {
    return { scripts: ['background.js'], type: 'module' };
  }
  return { service_worker: 'background.js', type: 'module' };
}

/** Generate the complete manifest for a target. */
export function generateManifest(ctx: BuildContext): Manifest {
  const base = {
    manifest_version: 3 as const,
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    version: ctx.version,
    default_locale: 'en',
    icons: ICONS,
    action: {
      default_title: '__MSG_extName__',
      default_popup: 'popup.html',
      default_icon: ICONS,
    },
    options_ui: {
      page: 'settings.html',
      open_in_tab: true,
    },
    background: backgroundFor(ctx.target),
    permissions: [...BASELINE_PERMISSIONS],
    optional_permissions: [...optionalPermissionsFor(ctx.target)],
    content_security_policy: { extension_pages: CSP },
    commands: COMMANDS,
  };

  if (ctx.target === 'firefox') {
    return {
      ...base,
      browser_specific_settings: {
        gecko: {
          id: FIREFOX_ADDON_ID,
          strict_min_version: FIREFOX_MIN_VERSION,
          // Declares that AetherDL collects no data at all (§14.1, §14.3). Firefox
          // only: Chromium manifests have no `browser_specific_settings` key.
          data_collection_permissions: FIREFOX_DATA_COLLECTION_PERMISSIONS,
        },
      },
    };
  }

  return base;
}
