/**
 * Module: platform/notifications
 * Purpose: Notifications API wrapper contract (PROJECT_BIBLE.md §4.10).
 *          Implementation lands in Phase 7.
 * Restrictions: Platform layer — depends only on shared/ (§8.4).
 * Dependencies: none.
 * Public API: NotificationSpec, NotificationsAdapter.
 */
export interface NotificationSpec {
  readonly title: string;
  readonly message: string;
  readonly iconUrl?: string;
}

export interface NotificationsAdapter {
  create(id: string, spec: NotificationSpec): Promise<void>;
  onClicked(listener: (id: string) => void): () => void;
}
