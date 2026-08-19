import { describe, expect, it } from 'vitest';
import { createPermissionsService } from '@platform/permissions/service';
import { createFakeWebExt } from './_fake-webext';

describe('platform/permissions service', () => {
  it('queries, requests, and removes API permissions', async () => {
    const permissions = createPermissionsService(createFakeWebExt().api);
    expect(await permissions.contains(['downloads'])).toBe(false);
    expect(await permissions.request(['downloads'])).toBe(true);
    expect(await permissions.contains(['downloads'])).toBe(true);
    expect(await permissions.remove(['downloads'])).toBe(true);
    expect(await permissions.contains(['downloads'])).toBe(false);
  });

  it('handles host permissions and reports a snapshot', async () => {
    const permissions = createPermissionsService(createFakeWebExt().api);
    await permissions.request(['downloads']);
    expect(await permissions.requestHosts(['https://ex.com/*'])).toBe(true);
    expect(await permissions.containsHosts(['https://ex.com/*'])).toBe(true);

    const snapshot = await permissions.getAll();
    expect(snapshot.permissions).toContain('downloads');
    expect(snapshot.origins).toContain('https://ex.com/*');

    expect(await permissions.removeHosts(['https://ex.com/*'])).toBe(true);
    expect(await permissions.containsHosts(['https://ex.com/*'])).toBe(false);
  });
});
