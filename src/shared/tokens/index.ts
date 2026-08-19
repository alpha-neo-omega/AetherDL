/**
 * Module: shared/tokens
 * Purpose: Non-visual mirror of design tokens for logic that needs token values
 *          outside the UI layer (PROJECT_BIBLE.md §11.13 — e.g. badge color).
 * Responsibilities: Provide token values consumable by non-UI code. The visual
 *          Material Design 3 token system lives in `ui/design-system` (§11.17).
 * Restrictions: Leaf layer — no internal dependencies (§8.16). No rendering.
 * Dependencies: none.
 * Public API: BADGE_BACKGROUND_COLOR, BADGE_TEXT_COLOR.
 */

/** Toolbar badge background color (§4.7). Kept legible in light and dark browser themes. */
export const BADGE_BACKGROUND_COLOR = '#4C6EF5';

/** Toolbar badge text color (§4.7). */
export const BADGE_TEXT_COLOR = '#FFFFFF';
