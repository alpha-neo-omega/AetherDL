/**
 * Module: platform/permissions
 * Purpose: Optional-permission query/request/revoke contract, including host
 *          permissions (PROJECT_BIBLE.md §4.15, §13.3, §13.7). Implementation in
 *          ./service.
 * Restrictions: Platform layer — depends only on shared/ (§8.4). Least privilege:
 *          host permissions are requested at point-of-use, never at install (§13.7).
 * Dependencies: none.
 * Public API: PermissionSnapshot, PermissionsAdapter.
 */

/** A snapshot of currently granted permissions. */
export interface PermissionSnapshot {
  readonly permissions: readonly string[];
  readonly origins: readonly string[];
}

export interface PermissionsAdapter {
  contains(permissions: readonly string[]): Promise<boolean>;
  request(permissions: readonly string[]): Promise<boolean>;
  remove(permissions: readonly string[]): Promise<boolean>;
  containsHosts(origins: readonly string[]): Promise<boolean>;
  requestHosts(origins: readonly string[]): Promise<boolean>;
  removeHosts(origins: readonly string[]): Promise<boolean>;
  getAll(): Promise<PermissionSnapshot>;
}
