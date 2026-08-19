/**
 * Module: platform/permissions (implementation)
 * Purpose: Implement {@link PermissionsAdapter} over the normalized WebExtension API
 *          (PROJECT_BIBLE.md §13.3). Platform access only — no policy about WHICH
 *          permissions to request (that belongs to features, later phases).
 * Restrictions: Platform layer — adapts only.
 * Public API: createPermissionsService.
 */
import type { PermissionSnapshot, PermissionsAdapter } from '@platform/permissions';
import type { WebExtApi } from '@platform/browser/webext';
import { PermissionError } from '@shared/result/errors';

export function createPermissionsService(api: WebExtApi): PermissionsAdapter {
  const fail = (operation: string, cause: unknown): never => {
    throw new PermissionError(`Permission ${operation} failed`, {
      code: `permission-${operation}-failed`,
      messageKey: 'error.permission.operation',
      cause,
    });
  };

  return {
    async contains(permissions: readonly string[]): Promise<boolean> {
      try {
        return await api.permissions.contains({ permissions });
      } catch (cause) {
        return fail('contains', cause);
      }
    },
    async request(permissions: readonly string[]): Promise<boolean> {
      try {
        return await api.permissions.request({ permissions });
      } catch (cause) {
        return fail('request', cause);
      }
    },
    async remove(permissions: readonly string[]): Promise<boolean> {
      try {
        return await api.permissions.remove({ permissions });
      } catch (cause) {
        return fail('remove', cause);
      }
    },
    async containsHosts(origins: readonly string[]): Promise<boolean> {
      try {
        return await api.permissions.contains({ origins });
      } catch (cause) {
        return fail('contains-hosts', cause);
      }
    },
    async requestHosts(origins: readonly string[]): Promise<boolean> {
      try {
        return await api.permissions.request({ origins });
      } catch (cause) {
        return fail('request-hosts', cause);
      }
    },
    async removeHosts(origins: readonly string[]): Promise<boolean> {
      try {
        return await api.permissions.remove({ origins });
      } catch (cause) {
        return fail('remove-hosts', cause);
      }
    },
    async getAll(): Promise<PermissionSnapshot> {
      try {
        const all = await api.permissions.getAll();
        return { permissions: all.permissions ?? [], origins: all.origins ?? [] };
      } catch (cause) {
        return fail('get-all', cause);
      }
    },
  };
}
