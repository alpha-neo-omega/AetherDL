/**
 * Module: platform/browser (environment helpers)
 * Purpose: Describe the runtime platform environment — target, capabilities, and
 *          extension version (PROJECT_BIBLE.md §7). There are no runtime secrets or
 *          remote environment by design (§14 privacy).
 * Restrictions: Platform layer — depends only on sibling browser modules and shared/.
 * Public API: PlatformEnvironment, describeEnvironment.
 */
import { detectCapabilities, type Capabilities } from '@platform/browser/capabilities';
import { readManifest } from '@platform/browser/manifest';
import type { PlatformTarget, WebExtApi } from '@platform/browser/webext';

export interface PlatformEnvironment {
  readonly target: PlatformTarget;
  readonly capabilities: Capabilities;
  readonly extensionVersion: string;
}

/** Describe the current platform environment. */
export function describeEnvironment(api: WebExtApi, target: PlatformTarget): PlatformEnvironment {
  return {
    target,
    capabilities: detectCapabilities(api, target),
    extensionVersion: readManifest(api).version,
  };
}
