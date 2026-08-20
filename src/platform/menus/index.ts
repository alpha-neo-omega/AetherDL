/**
 * Module: platform/menus
 * Purpose: Abstraction over `contextMenus` (Chromium) / `menus` (Firefox)
 *          (PROJECT_BIBLE.md §4.13, §7.4). Implementation lands in Phase 7.
 * Restrictions: Platform layer — depends only on shared/ (§8.4).
 * Dependencies: none.
 * Public API: MenuItemSpec, MenusAdapter.
 */
export interface MenuItemSpec {
  readonly id: string;
  readonly title: string;
  readonly contexts: readonly string[];
}

export interface MenusAdapter {
  /**
   * Whether the menu namespace exists RIGHT NOW. The namespace appears the moment the
   * optional permission is granted, so this is asked per call rather than answered
   * once at start-up: a build that decided at boot left the feature dead for the rest
   * of the session after the user granted it (§13.3, §7.2).
   */
  available(): boolean;
  create(spec: MenuItemSpec): Promise<void>;
  remove(id: string): Promise<void>;
  onClicked(listener: (id: string) => void): () => void;
}
