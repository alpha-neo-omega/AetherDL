/**
 * Module: ui/history
 * Purpose: The history view (PROJECT_BIBLE.md §11.3, §4.11). Local-only.
 * Responsibilities: Browse/filter/sort/search history, per-record delete, and bulk
 *          clear/export. It reads records handed over by the background and issues
 *          intents; it owns no domain state (§8.7).
 * Restrictions: UI layer — no platform/ or runtime/ imports (§8.4). History never
 *          leaves the device (§14.1).
 * Public API: HistoryView (+ props/labels) and the pure query helper.
 */
export {
  filterHistory,
  HistoryView,
  type HistoryOutcomeFilter,
  type HistorySortKey,
  type HistoryViewLabels,
  type HistoryViewProps,
} from './view';
