// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { HistoryRecord } from '@shared/types';
import { filterHistory, HistoryView, type HistoryViewLabels } from '@ui/history';
import { createSettingsTranslator } from '@ui/settings';
import { byName, click, render, requireByName, selectOption, texts, type } from '../_render';

const t = createSettingsTranslator();
const NOW = 1_700_000_000_000;

const labels: HistoryViewLabels = {
  title: t('history.title'),
  searchLabel: t('history.searchLabel'),
  searchPlaceholder: t('history.searchPlaceholder'),
  outcomeLabel: t('history.outcomeLabel'),
  outcomes: {
    all: t('history.outcome.all'),
    completed: t('history.outcome.completed'),
    failed: t('history.outcome.failed'),
  },
  sortLabel: t('history.sortLabel'),
  sorts: {
    newest: t('history.sort.newest'),
    oldest: t('history.sort.oldest'),
    title: t('history.sort.title'),
    size: t('history.sort.size'),
  },
  count: (total) =>
    total === 1 ? t('history.count.one') : t('history.count.other', { count: String(total) }),
  empty: t('history.empty'),
  noMatches: t('history.noMatches'),
  disabled: t('history.disabled'),
  delete: t('history.delete'),
  clear: t('history.clear'),
  clearHint: t('history.clearHint'),
  export: t('history.export'),
  exportHint: t('history.exportHint'),
  listLabel: t('history.list.label'),
  fields: {
    outcome: t('history.field.outcome'),
    size: t('history.field.size'),
    host: t('history.field.host'),
    when: t('history.field.when'),
    filename: t('history.field.filename'),
  },
};

function record(props: Partial<HistoryRecord> & { readonly id: string }): HistoryRecord {
  return {
    title: `Title ${props.id}`,
    kind: 'video',
    originHost: 'example.com',
    timestamp: NOW,
    outcome: 'completed',
    filename: `${props.id}.mp4`,
    ...props,
  };
}

const handlers = { onDelete: vi.fn(), onClear: vi.fn(), onExport: vi.fn() };

function renderView(records: readonly HistoryRecord[], enabled = true) {
  return render(
    <HistoryView
      records={records}
      enabled={enabled}
      labels={labels}
      locale="en-US"
      {...handlers}
    />,
  );
}

describe('ui/history filterHistory', () => {
  const records = [
    record({ id: 'a', title: 'Beach Clip', timestamp: NOW - 100, sizeBytes: 10 }),
    record({ id: 'b', title: 'Lecture', outcome: 'failed', originHost: 'campus.test' }),
    record({ id: 'c', title: 'Song', container: 'mp3', sizeBytes: 900 }),
  ];

  it('returns everything, newest first, by default', () => {
    expect(filterHistory(records, '', 'all', 'newest').map((entry) => entry.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });

  it('filters by outcome', () => {
    expect(filterHistory(records, '', 'failed', 'newest').map((entry) => entry.id)).toEqual(['b']);
    expect(filterHistory(records, '', 'completed', 'newest').map((entry) => entry.id)).toEqual([
      'c',
      'a',
    ]);
  });

  it('searches title, host, container and filename case-insensitively', () => {
    expect(filterHistory(records, 'BEACH', 'all', 'newest').map((entry) => entry.id)).toEqual([
      'a',
    ]);
    expect(filterHistory(records, 'campus', 'all', 'newest').map((entry) => entry.id)).toEqual([
      'b',
    ]);
    expect(filterHistory(records, 'mp3', 'all', 'newest').map((entry) => entry.id)).toEqual(['c']);
    expect(filterHistory(records, 'a.mp4', 'all', 'newest').map((entry) => entry.id)).toEqual([
      'a',
    ]);
    expect(filterHistory(records, '   ', 'all', 'newest')).toHaveLength(3);
  });

  it('sorts oldest first, by title, and by size', () => {
    expect(filterHistory(records, '', 'all', 'oldest').map((entry) => entry.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(filterHistory(records, '', 'all', 'title').map((entry) => entry.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(filterHistory(records, '', 'all', 'size').map((entry) => entry.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('breaks a tie by id for every sort order', () => {
    const tied = [
      record({ id: 'b', title: 'Same', timestamp: NOW, sizeBytes: 10 }),
      record({ id: 'a', title: 'Same', timestamp: NOW, sizeBytes: 10 }),
    ];
    for (const sort of ['newest', 'oldest', 'title', 'size'] as const) {
      expect(
        filterHistory(tied, '', 'all', sort).map((entry) => entry.id),
        sort,
      ).toEqual(['a', 'b']);
    }
  });

  it('is deterministic and does not mutate its input', () => {
    const same = [record({ id: 'z' }), record({ id: 'y' })];
    const snapshot = same.map((entry) => entry.id);
    expect(filterHistory(same, '', 'all', 'newest').map((entry) => entry.id)).toEqual(['y', 'z']);
    expect(same.map((entry) => entry.id)).toEqual(snapshot);
  });
});

describe('ui/history HistoryView', () => {
  it('lists records with their metadata, each field named for assistive tech', () => {
    const view = renderView([
      record({ id: 'a', title: 'Beach Clip', sizeBytes: 5 * 1024 * 1024, outcome: 'failed' }),
    ]);

    expect(texts(view.container, '.adl-history__item-title')).toEqual(['Beach Clip']);
    const values = texts(view.container, '.adl-history__item dd');
    expect(values).toContain('Failed');
    expect(values).toContain('5 MB');
    expect(values).toContain('example.com');
    expect(values).toContain('a.mp4');
    expect(texts(view.container, '.adl-history__item dt')).toEqual([
      'Outcome',
      'Size',
      'Host',
      'Downloaded',
      'Filename',
    ]);
    view.unmount();
  });

  it('omits an unknown size rather than inventing one', () => {
    const view = renderView([record({ id: 'a' })]);
    expect(texts(view.container, '.adl-history__item dt')).toEqual([
      'Outcome',
      'Host',
      'Downloaded',
      'Filename',
    ]);
    view.unmount();
  });

  it('counts what is visible and announces it politely', () => {
    const view = renderView([record({ id: 'a' }), record({ id: 'b' })]);
    const count = view.container.querySelector('.adl-history__count');
    expect(count?.textContent).toBe('2 records');
    expect(count?.getAttribute('aria-live')).toBe('polite');
    view.unmount();
  });

  it('uses the singular count for one record', () => {
    const view = renderView([record({ id: 'a' })]);
    expect(view.container.querySelector('.adl-history__count')?.textContent).toBe('1 record');
    view.unmount();
  });

  it('narrows the list by search, outcome and sort', () => {
    const view = renderView([
      record({ id: 'a', title: 'Beach Clip' }),
      record({ id: 'b', title: 'Lecture', outcome: 'failed' }),
    ]);

    type(view.container.querySelector('input[type="search"]') as HTMLInputElement, 'beach');
    expect(texts(view.container, '.adl-history__item-title')).toEqual(['Beach Clip']);

    type(view.container.querySelector('input[type="search"]') as HTMLInputElement, '');
    const selects = view.container.querySelectorAll('select');
    selectOption(selects[0] as HTMLSelectElement, 'failed');
    expect(texts(view.container, '.adl-history__item-title')).toEqual(['Lecture']);

    selectOption(selects[0] as HTMLSelectElement, 'all');
    selectOption(selects[1] as HTMLSelectElement, 'title');
    expect(texts(view.container, '.adl-history__item-title')).toEqual(['Beach Clip', 'Lecture']);
    view.unmount();
  });

  it('says when nothing matches the search', () => {
    const view = renderView([record({ id: 'a', title: 'Beach' })]);
    type(view.container.querySelector('input[type="search"]') as HTMLInputElement, 'zzz');
    expect(view.container.querySelector('.adl-history__empty')?.textContent).toBe(
      'No records match your search.',
    );
    view.unmount();
  });

  it('explains an empty history, and explains it differently when recording is off', () => {
    const empty = renderView([]);
    expect(empty.container.querySelector('.adl-history__empty')?.textContent).toBe(
      'Nothing downloaded yet.',
    );
    empty.unmount();

    const off = renderView([], false);
    expect(off.container.querySelector('.adl-history__empty')?.textContent).toBe(
      'History is off, so nothing is being recorded.',
    );
    off.unmount();
  });

  it('disables export and clear while there is nothing to act on', () => {
    const view = renderView([]);
    const exportButton = requireByName(
      view.container,
      'Export history — Saves a JSON file to your device.',
    ) as HTMLButtonElement;
    const clearButton = requireByName(
      view.container,
      'Clear history — Erases every record from this device.',
    ) as HTMLButtonElement;

    expect(exportButton.disabled).toBe(true);
    expect(clearButton.disabled).toBe(true);
    expect(clearButton.getAttribute('title')).toBe('Nothing downloaded yet.');
    view.unmount();
  });

  it('sends delete, clear and export as intents', () => {
    handlers.onDelete.mockClear();
    handlers.onClear.mockClear();
    handlers.onExport.mockClear();
    const view = renderView([record({ id: 'a', title: 'Beach Clip' })]);

    click(requireByName(view.container, 'Delete: Beach Clip'));
    click(requireByName(view.container, 'Clear history — Erases every record from this device.'));
    click(requireByName(view.container, 'Export history — Saves a JSON file to your device.'));

    expect(handlers.onDelete).toHaveBeenCalledWith('a');
    expect(handlers.onClear).toHaveBeenCalledTimes(1);
    expect(handlers.onExport).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('names the list and every control', () => {
    const view = renderView([record({ id: 'a' })]);
    expect(view.container.querySelector('.adl-history__list')?.getAttribute('aria-label')).toBe(
      'History records',
    );
    expect(byName(view.container, 'Delete: Title a')).toBeDefined();
    for (const control of view.container.querySelectorAll('input, select')) {
      expect(control.closest('label')).not.toBeNull();
    }
    view.unmount();
  });
});
