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
  create(spec: MenuItemSpec): Promise<void>;
  remove(id: string): Promise<void>;
  onClicked(listener: (id: string) => void): () => void;
}
