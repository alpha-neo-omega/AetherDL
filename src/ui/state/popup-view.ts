/**
 * Module: ui/state (popup view state)
 * Purpose: UI-local, ephemeral view state for the popup — search text, kind filter,
 *          sort order and selection (PROJECT_BIBLE.md §8.7, §13.1, §4.12).
 * Restrictions: UI layer — never persisted to disk and never a mirror of domain
 *          state; detection results and the download queue stay owned by the
 *          background (§13.2). Pure reducer: no effects, no platform/ or runtime/
 *          imports (§8.4).
 * Public API: KindFilter, PopupViewState, PopupViewAction, INITIAL_POPUP_VIEW,
 *          popupViewReducer, toFilterSpec.
 */
import type { FilterSpec, SortSpec } from '@core/query';
import type { MediaKind } from '@shared/types';

export type KindFilter = MediaKind | 'all';

export interface PopupViewState {
  readonly search: string;
  readonly kind: KindFilter;
  readonly sort: SortSpec;
  /** Ids of items picked for a bulk action (§11.6). */
  readonly selected: ReadonlySet<string>;
}

export type PopupViewAction =
  | { readonly type: 'search'; readonly value: string }
  | { readonly type: 'kind'; readonly value: KindFilter }
  | { readonly type: 'sort'; readonly value: SortSpec }
  | { readonly type: 'toggle'; readonly itemId: string }
  | { readonly type: 'select-all'; readonly itemIds: readonly string[] }
  | { readonly type: 'clear-selection' }
  /** Drop selections for items that are no longer on the page (§9.9 invalidation). */
  | { readonly type: 'reconcile'; readonly itemIds: readonly string[] };

/** Default view: everything, most likely media first (§9.7 scoring drives order). */
export const INITIAL_POPUP_VIEW: PopupViewState = {
  search: '',
  kind: 'all',
  sort: { key: 'score', direction: 'desc' },
  selected: new Set<string>(),
};

export function popupViewReducer(state: PopupViewState, action: PopupViewAction): PopupViewState {
  switch (action.type) {
    case 'search':
      return { ...state, search: action.value };
    case 'kind':
      return { ...state, kind: action.value };
    case 'sort':
      return { ...state, sort: action.value };
    case 'toggle': {
      const selected = new Set(state.selected);
      if (!selected.delete(action.itemId)) {
        selected.add(action.itemId);
      }
      return { ...state, selected };
    }
    case 'select-all':
      return { ...state, selected: new Set(action.itemIds) };
    case 'clear-selection':
      return state.selected.size === 0 ? state : { ...state, selected: new Set<string>() };
    case 'reconcile': {
      const available = new Set(action.itemIds);
      const kept = [...state.selected].filter((id) => available.has(id));
      // Preserve identity when nothing changed so consumers do not re-render.
      return kept.length === state.selected.size ? state : { ...state, selected: new Set(kept) };
    }
    default:
      return state;
  }
}

/** Project the view state onto the core query engine's filter contract (§4.12). */
export function toFilterSpec(state: PopupViewState): FilterSpec {
  return {
    ...(state.kind !== 'all' && { kind: state.kind }),
    ...(state.search.trim() !== '' && { text: state.search.trim() }),
  };
}
