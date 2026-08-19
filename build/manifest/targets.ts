/**
 * Module: build/manifest (targets)
 * Purpose: Declare the supported build targets and the shared build context type
 *          used across the build pipeline (PROJECT_BIBLE.md §7.6 build targets,
 *          §7.1 supported browsers).
 * Responsibilities: Enumerate targets; define BuildContext and the baseline
 *          permission allow-list (PROJECT_BIBLE.md §13.3).
 * Restrictions: Build tooling only; no product logic.
 * Public API: Target, BuildMode, BuildContext, TARGETS, BASELINE_PERMISSIONS,
 *          optionalPermissionsFor, FIREFOX_ADDON_ID, FIREFOX_MIN_VERSION.
 */

/** Chromium family (Chrome, Edge, Brave, Opera, Vivaldi) collapses to `chrome`. */
export type Target = 'chrome' | 'firefox';

export type BuildMode = 'development' | 'production';

export interface BuildContext {
  readonly target: Target;
  readonly mode: BuildMode;
  readonly version: string;
}

/** All targets produced by a full build. */
export const TARGETS: readonly Target[] = ['chrome', 'firefox'];

/**
 * Baseline install-time permissions (PROJECT_BIBLE.md §13.3). Least privilege:
 * no broad host permissions are declared at install (§13.7). Elevated capabilities
 * are requested as optional permissions at point-of-use in later phases.
 */
export const BASELINE_PERMISSIONS: readonly string[] = [
  'storage',
  'downloads',
  'activeTab',
  'scripting',
];

/**
 * Optional permissions, requested at point-of-use on a user gesture and revocable
 * (PROJECT_BIBLE.md §4.15, §13.3). No host permission is declared: broad access is
 * never requested up front (§13.7).
 *
 * Chromium offers its context-menu permission optionally (`contextMenus`). Firefox
 * does NOT accept `menus` in `optional_permissions` — Mozilla's own add-on linter
 * rejects it — and asking for it at install instead would take a permission the
 * user never chose, so Firefox declares neither. The context-menu feature therefore
 * reports itself unavailable on Firefox and degrades gracefully (§7.2, §7.4); the
 * surfaces read what this manifest declares rather than testing for a browser.
 */
export function optionalPermissionsFor(target: Target): readonly string[] {
  return target === 'firefox' ? ['notifications'] : ['notifications', 'contextMenus'];
}

/** Firefox requires a stable add-on id for several WebExtension APIs. */
export const FIREFOX_ADDON_ID = 'aetherdl@aetherdl.app';

/** Minimum Firefox version supporting the MV3 features AetherDL relies on. */
export const FIREFOX_MIN_VERSION = '115.0';

/**
 * Firefox data-collection disclosure (`browser_specific_settings.gecko`), required by
 * addons.mozilla.org for a submission.
 *
 * `required: ['none']` is Mozilla's declaration that the add-on collects NO data. It
 * is the only value consistent with what AetherDL is: no analytics, no telemetry, no
 * tracking, no data collection, everything processed on-device (PROJECT_BIBLE.md
 * §14.1 guarantees 1-7, non-goal N7), and no network call of its own at all (§14.3).
 * The disclosure DESCRIBES that existing behaviour; it grants nothing, requests no
 * permission, and changes no code path.
 *
 * Ratified by the Project Owner on 2026-08-19 for Phase 10 (§22.11 store packages);
 * the value is absent from the governance documents, so it was escalated rather than
 * assumed. Mozilla introduced the key in Firefox 140 / Firefox for Android 142, so a
 * build declaring an older `strict_min_version` keeps ESR support (§7.1) and simply
 * carries a linter notice that older versions ignore the key — the Owner chose to
 * keep `FIREFOX_MIN_VERSION` unchanged.
 */
export const FIREFOX_DATA_COLLECTION_PERMISSIONS: { readonly required: readonly string[] } = {
  required: ['none'],
};
