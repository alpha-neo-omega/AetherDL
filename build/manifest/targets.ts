/**
 * Module: build/manifest (targets)
 * Purpose: Declare the supported build targets and the shared build context type
 *          used across the build pipeline (PROJECT_BIBLE.md §7.6 build targets,
 *          §7.1 supported browsers).
 * Responsibilities: Enumerate targets; define BuildContext and the baseline
 *          permission allow-list (PROJECT_BIBLE.md §13.3).
 * Restrictions: Build tooling only; no product logic.
 * Public API: Target, BuildMode, BuildContext, TARGETS, BASELINE_PERMISSIONS,
 *          permissionsFor, optionalPermissionsFor, STREAM_HOST_PATTERN,
 *          optionalHostPermissionsFor, hostPermissionsFor, FIREFOX_ADDON_ID,
 *          FIREFOX_MIN_VERSION.
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

/**
 * Install-time permissions per target. Chromium adds `offscreen`: a Chromium MV3
 * service worker cannot create the `blob:` URL that hands an assembled stream to the
 * download manager, so assembly runs in an offscreen document (§10.6, §7.4). The
 * permission is not user-visible in the install prompt and grants no host access.
 * Firefox needs nothing extra — its event page has the DOM APIs already.
 */
export function permissionsFor(target: Target): readonly string[] {
  return target === 'firefox' ? BASELINE_PERMISSIONS : [...BASELINE_PERMISSIONS, 'offscreen'];
}

/**
 * The host pattern stream assembly needs. Segments of one stream are routinely spread
 * across CDNs the manifest only names at read time, so no narrower pattern can be
 * declared up front. It is declared OPTIONAL and requested at point of use, on a user
 * gesture, for the specific origins in play — never taken at install (§13.7, §4.15).
 */
export const STREAM_HOST_PATTERN = '*://*/*';

/**
 * Both targets keep the pattern in `optional_host_permissions`, which is granted only
 * when the user is asked and agrees (§13.7).
 *
 * Firefox was measured, not assumed: a build declaring the pattern under
 * `host_permissions` came back from `permissions.getAll()` with the origin ALREADY
 * GRANTED at install. Whatever the intent of Firefox's "optional by default" model,
 * that is an install-time grant of access to every site, so that route is not used.
 *
 * The cost is stated rather than hidden: Firefox added `optional_host_permissions` in
 * Firefox 128, so on Firefox 115–127 (inside the supported range, §7.1) the pattern
 * cannot be requested at all and stream assembly is simply unavailable — the download
 * fails with a permission error instead of silently taking access. Progressive
 * downloads, which need no host permission, are unaffected.
 */
export function optionalHostPermissionsFor(_target: Target): readonly string[] {
  return [STREAM_HOST_PATTERN];
}

/**
 * No target declares install-time host permissions (§13.7). Kept as the single place
 * that says so, and enforced by the packaging validator and the security gate.
 */
export function hostPermissionsFor(_target: Target): readonly string[] {
  return [];
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
