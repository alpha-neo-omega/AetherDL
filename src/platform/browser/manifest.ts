/**
 * Module: platform/browser (manifest helpers)
 * Purpose: Typed access to the extension manifest (PROJECT_BIBLE.md §7.6).
 * Restrictions: Platform layer — depends only on the WebExtension normalization.
 * Public API: AppManifest, readManifest.
 */
import type { WebExtApi } from '@platform/browser/webext';

export interface AppManifest {
  readonly version: string;
  readonly name: string | undefined;
  readonly manifestVersion: number | undefined;
  /**
   * Optional permissions this target's manifest actually declares. A permission a
   * target cannot offer optionally is simply absent, so a surface can ask what is
   * offerable here instead of testing which browser it is running in (§7.2).
   */
  readonly optionalPermissions: readonly string[];
}

/** Read the extension manifest as a typed, minimal projection. */
export function readManifest(api: WebExtApi): AppManifest {
  const manifest = api.runtime.getManifest();
  const optional: unknown = (manifest as { optional_permissions?: unknown }).optional_permissions;
  return {
    version: manifest.version,
    name: manifest.name,
    manifestVersion: manifest.manifest_version,
    optionalPermissions: Array.isArray(optional)
      ? optional.filter((entry): entry is string => typeof entry === 'string')
      : [],
  };
}
