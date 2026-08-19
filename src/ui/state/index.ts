/**
 * Module: ui/state
 * Purpose: UI-local, ephemeral state — filters, selection, view mode
 *          (PROJECT_BIBLE.md §8.7, §13.1). Never persisted to disk.
 * Responsibilities: Manage per-surface view state; domain state is read from the
 *          runtime, never duplicated (§13.2).
 * Restrictions: UI layer — no platform/ or runtime/ imports (§8.4).
 * Public API: the popup view state reducer (./popup-view).
 */
export {
  INITIAL_POPUP_VIEW,
  popupViewReducer,
  toFilterSpec,
  type KindFilter,
  type PopupViewAction,
  type PopupViewState,
} from './popup-view';
