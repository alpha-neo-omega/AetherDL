/**
 * Module: platform/browser/action
 * Purpose: Toolbar action abstraction — badge text/color, title, enable/disable
 *          (PROJECT_BIBLE.md §4.7). Ratified additive platform capability; the ONLY
 *          home for `chrome.action` / `browser.action` access (§8.4).
 * Restrictions: Platform layer — depends only on shared/ and sibling platform
 *          contracts. No product logic; runtime consumes ActionAdapter only.
 * Public API: ActionAdapter.
 */

/**
 * Toolbar action control. All writes are optionally scoped to a tab (`tabId`); when
 * omitted the browser applies the global default. Per-tab badge state (§4.7) is
 * expressed by passing the `tabId`.
 */
export interface ActionAdapter {
  /** Set the badge text; empty string clears the badge (§4.7). */
  setBadgeText(text: string, tabId?: number): Promise<void>;
  /** Set the badge background color (CSS hex, e.g. `#4C6EF5`). */
  setBadgeBackgroundColor(color: string, tabId?: number): Promise<void>;
  /** Set the toolbar tooltip title. */
  setTitle(title: string, tabId?: number): Promise<void>;
  /** Enable the action for a tab (or globally). */
  enable(tabId?: number): Promise<void>;
  /** Disable the action for a tab (or globally). */
  disable(tabId?: number): Promise<void>;
}
