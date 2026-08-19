/**
 * Module: platform/notifications (implementation)
 * Purpose: Implement {@link NotificationsAdapter} over the Notifications API
 *          (PROJECT_BIBLE.md §4.10).
 * Restrictions: Platform layer — adapts only. It decides nothing about WHEN a
 *          notification is appropriate; the background gates that behind the user's
 *          setting and the optional permission (§4.10, §13.3). The namespace is
 *          absent until that permission is granted, so the factory constructs this
 *          adapter only when the capability is present.
 * Public API: createNotificationsService.
 */
import type { NotificationSpec, NotificationsAdapter } from '@platform/notifications';
import type { WebExtNotifications } from '@platform/browser/webext';
import { PlatformError } from '@shared/result/errors';
import { createMultiplexer } from '@shared/utils';

/** Notification failure. Category `capability`: the API may be unavailable. */
class NotificationsError extends PlatformError {
  readonly category = 'capability' as const;
}

/** Create the notifications service over a resolved WebExtension namespace. */
export function createNotificationsService(
  notifications: WebExtNotifications,
): NotificationsAdapter {
  const clicks = createMultiplexer<[string]>((emit) => {
    const listener = (notificationId: string): void => {
      emit(notificationId);
    };
    notifications.onClicked.addListener(listener);
    return () => {
      notifications.onClicked.removeListener(listener);
    };
  });

  return {
    async create(id: string, spec: NotificationSpec): Promise<void> {
      try {
        await notifications.create(id, {
          type: 'basic',
          title: spec.title,
          message: spec.message,
          ...(spec.iconUrl !== undefined && { iconUrl: spec.iconUrl }),
        });
      } catch (cause) {
        throw new NotificationsError('Notification could not be shown', {
          code: 'notifications-create-failed',
          messageKey: 'error.capability.notifications',
          cause,
        });
      }
    },

    onClicked(listener: (id: string) => void): () => void {
      return clicks.subscribe(listener);
    },
  };
}
