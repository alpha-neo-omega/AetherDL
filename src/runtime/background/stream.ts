/**
 * Module: runtime/background (stream delivery resolution)
 * Purpose: Choose how this engine assembles HLS/DASH downloads (PROJECT_BIBLE.md
 *          §10.6, §7.4). Composition only — the deciding is one capability check,
 *          not a browser-name check (§7.2).
 * Restrictions: Thin surface (§8.1). Assembly logic lives in core/download/stream;
 *          network access in platform/http; encrypted streams are refused there and
 *          nothing here can override that (§6, ADR-005).
 * Dependencies: platform/browser, platform/http, platform/objecturl, platform/stream,
 *              core/download/stream.
 * Public API: resolveStreamDelivery.
 */
import type { Browser } from '@platform/browser';
import { createHttpClient } from '@platform/http/service';
import { createObjectUrlAdapter } from '@platform/objecturl/service';
import type { StreamDeliveryAdapter } from '@platform/stream';
import { createLocalStreamDelivery } from '@core/download/stream/deliver';

/**
 * The adapter this context can actually use:
 *
 * - A context that can create object URLs (a Firefox MV3 event page) assembles in
 *   place — no extra document, no extra messaging.
 * - A Chromium MV3 service worker cannot, so it delegates to the offscreen document
 *   through the facade's client.
 * - Anything else gets nothing, and stream items stay refused at validation.
 */
export function resolveStreamDelivery(browser: Browser): StreamDeliveryAdapter | undefined {
  const objectUrl = createObjectUrlAdapter();
  if (objectUrl.supported) {
    return createLocalStreamDelivery({ http: createHttpClient(), objectUrl });
  }
  return browser.stream?.supported === true ? browser.stream : undefined;
}
