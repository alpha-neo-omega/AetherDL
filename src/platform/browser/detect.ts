/**
 * Module: platform/browser (browser detection)
 * Purpose: Capability-based browser detection helpers (PROJECT_BIBLE.md §7.2 —
 *          feature detection, not user-agent sniffing).
 * Restrictions: Platform layer — depends only on the WebExtension normalization
 *          and shared/. No product logic.
 * Public API: isFirefox, isChromium.
 */
import { detectTarget, type WebExtApi } from '@platform/browser/webext';

/** Whether the resolved API belongs to the Firefox (Gecko) family. */
export function isFirefox(api: WebExtApi): boolean {
  return detectTarget(api) === 'firefox';
}

/** Whether the resolved API belongs to the Chromium (Blink) family. */
export function isChromium(api: WebExtApi): boolean {
  return detectTarget(api) === 'chrome';
}
