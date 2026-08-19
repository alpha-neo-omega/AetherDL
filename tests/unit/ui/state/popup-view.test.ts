import { describe, expect, it } from 'vitest';
import { INITIAL_POPUP_VIEW, popupViewReducer, toFilterSpec, type PopupViewState } from '@ui/state';

function state(props: Partial<PopupViewState> = {}): PopupViewState {
  return { ...INITIAL_POPUP_VIEW, ...props };
}

describe('ui/state popup view reducer', () => {
  it('starts unfiltered, sorted by score, with nothing selected', () => {
    expect(INITIAL_POPUP_VIEW).toEqual({
      search: '',
      kind: 'all',
      sort: { key: 'score', direction: 'desc' },
      selected: new Set<string>(),
    });
  });

  it('records the search text and kind filter', () => {
    const searched = popupViewReducer(state(), { type: 'search', value: 'clip' });
    expect(searched.search).toBe('clip');
    const filtered = popupViewReducer(searched, { type: 'kind', value: 'audio' });
    expect(filtered.kind).toBe('audio');
    expect(filtered.search).toBe('clip');
  });

  it('records the sort order', () => {
    const next = popupViewReducer(state(), {
      type: 'sort',
      value: { key: 'title', direction: 'asc' },
    });
    expect(next.sort).toEqual({ key: 'title', direction: 'asc' });
  });

  it('toggles a selection on and back off', () => {
    const on = popupViewReducer(state(), { type: 'toggle', itemId: 'a' });
    expect([...on.selected]).toEqual(['a']);
    const off = popupViewReducer(on, { type: 'toggle', itemId: 'a' });
    expect([...off.selected]).toEqual([]);
  });

  it('selects all and clears the selection', () => {
    const all = popupViewReducer(state(), { type: 'select-all', itemIds: ['a', 'b'] });
    expect([...all.selected]).toEqual(['a', 'b']);
    const cleared = popupViewReducer(all, { type: 'clear-selection' });
    expect([...cleared.selected]).toEqual([]);
  });

  it('keeps identity when clearing an already empty selection', () => {
    const start = state();
    expect(popupViewReducer(start, { type: 'clear-selection' })).toBe(start);
  });

  it('reconciles the selection against the items still detected', () => {
    const selected = popupViewReducer(state(), { type: 'select-all', itemIds: ['a', 'b', 'c'] });
    const reconciled = popupViewReducer(selected, { type: 'reconcile', itemIds: ['b'] });
    expect([...reconciled.selected]).toEqual(['b']);
  });

  it('keeps identity when reconciling changes nothing', () => {
    const selected = popupViewReducer(state(), { type: 'select-all', itemIds: ['a'] });
    expect(popupViewReducer(selected, { type: 'reconcile', itemIds: ['a', 'b'] })).toBe(selected);
  });

  it('never mutates the previous state', () => {
    const start = state();
    popupViewReducer(start, { type: 'toggle', itemId: 'a' });
    expect(start.selected.size).toBe(0);
  });

  it('projects onto the core filter contract, trimming the search text', () => {
    expect(toFilterSpec(state())).toEqual({});
    expect(toFilterSpec(state({ kind: 'video', search: '  clip  ' }))).toEqual({
      kind: 'video',
      text: 'clip',
    });
    expect(toFilterSpec(state({ search: '   ' }))).toEqual({});
  });
});
