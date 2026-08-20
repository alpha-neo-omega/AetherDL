/**
 * Module: runtime/offscreen (entry)
 * Purpose: Entry point for the Chromium offscreen document that assembles streams
 *          (PROJECT_BIBLE.md §10.6, §7.4). Coverage-excluded: it touches the ambient
 *          browser namespace, and the host it starts is unit-tested in ./host.
 * Restrictions: Thin surface — composition and lifecycle only (§8.1).
 */
import { resolveMessagingApi } from '@platform/browser/webext';
import { createMessageBus } from '@platform/messaging/service';
import { createStreamAssemblyHost } from '@runtime/offscreen/host';

// Messaging only, and resolved through the messaging-only resolver: an offscreen
// document exposes `chrome.runtime` messaging but not `runtime.getManifest`, so
// neither the platform facade nor the ordinary resolver can be used here (§7.4).
const host = createStreamAssemblyHost({
  messaging: createMessageBus(resolveMessagingApi().api),
});
host.start();

// The document is closed by the service worker once the download is under way; this
// only guards the case where the browser tears the page down first.
globalThis.addEventListener('unload', () => {
  void host.dispose();
});
