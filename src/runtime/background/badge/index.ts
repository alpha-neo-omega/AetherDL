/**
 * Module: runtime/background/badge
 * Purpose: Per-tab toolbar badge orchestration (PROJECT_BIBLE.md §4.7).
 * Responsibilities: (Phase 3) reflect the active tab's detected-media count via the
 *          platform action adapter; throttle writes to avoid flicker (§12).
 * Restrictions: Thin surface — delegates to platform/core; no domain logic (§8.1).
 * Public API: (established in Phase 3). Intentionally empty in Phase 1.
 */
export {};
