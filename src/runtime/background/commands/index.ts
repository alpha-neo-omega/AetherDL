/**
 * Module: runtime/background/commands
 * Purpose: Keyboard command support (PROJECT_BIBLE.md §4.14). The ratified command
 *          is "a command opens the popup", which MV3 expresses declaratively: the
 *          generated manifest binds {@link OPEN_POPUP_COMMAND} and the browser opens
 *          the popup itself. Neither engine raises `commands.onCommand` for that
 *          reserved command, so there is deliberately no background dispatcher to
 *          write — a listener here would never fire.
 * Restrictions: Thin surface — no domain logic (§8.1). Shortcuts must not clash with
 *          common browser shortcuts and must be documented (§4.14, §17.2); the
 *          Settings page surfaces the binding for discoverability.
 * Public API: OPEN_POPUP_COMMAND, DEFAULT_OPEN_POPUP_SHORTCUT.
 */

/** The reserved MV3 command that opens the toolbar popup (§4.14). */
export const OPEN_POPUP_COMMAND = '_execute_action';

/**
 * The suggested binding, shown in Settings so the shortcut is discoverable (§4.14).
 * Chosen to avoid the common browser shortcuts on both platforms.
 */
export const DEFAULT_OPEN_POPUP_SHORTCUT = {
  default: 'Ctrl+Shift+Y',
  mac: 'Command+Shift+Y',
} as const;
