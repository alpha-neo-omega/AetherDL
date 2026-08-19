/**
 * Module: platform/browser/action (implementation)
 * Purpose: Implement {@link ActionAdapter} over the normalized `action` namespace.
 *          Writes are best-effort: a rejected write (e.g. a tab closed mid-update)
 *          surfaces as a typed {@link RuntimeError} for the caller to tolerate (§20.7).
 * Restrictions: Platform layer — adapts only; no product logic. The `action`
 *          namespace is absent in content-script contexts, so every call guards it.
 * Public API: createActionService.
 */
import type { ActionAdapter } from '@platform/browser/action';
import type { WebExtApi, WebExtAction } from '@platform/browser/webext';
import { RuntimeError } from '@shared/result/errors';

function requireAction(api: WebExtApi): WebExtAction {
  const action = api.action;
  if (action === undefined) {
    throw new RuntimeError('Toolbar action API is unavailable in this context', {
      code: 'action-unavailable',
      messageKey: 'error.runtime.unavailable',
    });
  }
  return action;
}

async function guard(operation: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (cause) {
    throw new RuntimeError(`Toolbar action "${operation}" failed`, {
      code: 'action-write-failed',
      messageKey: 'error.runtime.action',
      cause,
    });
  }
}

/** Create the toolbar action service over a resolved WebExtension API. */
export function createActionService(api: WebExtApi): ActionAdapter {
  return {
    setBadgeText(text: string, tabId?: number): Promise<void> {
      return guard('setBadgeText', () =>
        requireAction(api).setBadgeText(tabId === undefined ? { text } : { text, tabId }),
      );
    },

    setBadgeBackgroundColor(color: string, tabId?: number): Promise<void> {
      return guard('setBadgeBackgroundColor', () =>
        requireAction(api).setBadgeBackgroundColor(
          tabId === undefined ? { color } : { color, tabId },
        ),
      );
    },

    setTitle(title: string, tabId?: number): Promise<void> {
      return guard('setTitle', () =>
        requireAction(api).setTitle(tabId === undefined ? { title } : { title, tabId }),
      );
    },

    enable(tabId?: number): Promise<void> {
      return guard('enable', () => requireAction(api).enable(tabId));
    },

    disable(tabId?: number): Promise<void> {
      return guard('disable', () => requireAction(api).disable(tabId));
    },
  };
}
