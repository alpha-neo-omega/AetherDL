/**
 * Module: runtime/background/badge
 * Purpose: Per-tab toolbar badge orchestration (PROJECT_BIBLE.md §4.7). Reflects the
 *          supported-media count for a tab; `0` shows no badge (empty text). Writes
 *          are coalesced (only on change) to avoid flicker, and go through the
 *          platform ActionAdapter — no browser-specific code here (§8.4).
 * Restrictions: Runtime layer — delegates to platform/action; no browser globals.
 *          Badge write failures are non-fatal (§20.7) and surfaced via `onError`.
 * Public API: BadgeController, BadgeControllerDeps, createBadgeController.
 */
import type { ActionAdapter } from '@platform/browser/action';
import { BADGE_BACKGROUND_COLOR } from '@shared/tokens';

export interface BadgeController {
  /** Reflect `count` supported items on `tabId`'s badge. */
  set(tabId: number, count: number): Promise<void>;
  /** Clear a tab's badge (and forget its cached value). */
  clear(tabId: number): Promise<void>;
  /** Forget a tab's cached value WITHOUT a write (call when the tab is gone). */
  forget(tabId: number): void;
  /** Forget all cached badge values. */
  dispose(): void;
}

export interface BadgeControllerDeps {
  readonly action: ActionAdapter;
  /** Called with the cause when a badge write fails (never throws to the caller). */
  readonly onError?: (cause: unknown) => void;
}

function badgeText(count: number): string {
  return count > 0 ? String(count) : '';
}

export function createBadgeController(deps: BadgeControllerDeps): BadgeController {
  const { action, onError } = deps;
  // Last text written per tab, so we only write on change (flicker-free, §4.7).
  const lastText = new Map<number, string>();

  const write = async (tabId: number, text: string): Promise<void> => {
    if (lastText.get(tabId) === text) {
      return;
    }
    lastText.set(tabId, text);
    try {
      await action.setBadgeText(text, tabId);
      if (text !== '') {
        await action.setBadgeBackgroundColor(BADGE_BACKGROUND_COLOR, tabId);
      }
    } catch (cause) {
      // A tab may have closed mid-write; keep the runtime alive (§20.7).
      lastText.delete(tabId);
      onError?.(cause);
    }
  };

  return {
    set(tabId: number, count: number): Promise<void> {
      return write(tabId, badgeText(count));
    },
    clear(tabId: number): Promise<void> {
      const result = write(tabId, '');
      lastText.delete(tabId);
      return result;
    },
    forget(tabId: number): void {
      lastText.delete(tabId);
    },
    dispose(): void {
      lastText.clear();
    },
  };
}
