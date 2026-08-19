/**
 * Module: ui/history (view)
 * Purpose: Browse local download history with search, filter and sort, delete a
 *          record, clear everything, and export a local JSON copy
 *          (PROJECT_BIBLE.md §11.3, §4.11, §4.12).
 * Restrictions: UI layer — presentational. It reads records the background handed
 *          over and issues intents; it stores nothing and transmits nothing. History
 *          is local-only and fully erasable, and this view is where the user erases
 *          it (§14.1, §14.4). Filtering, sorting and search run synchronously over
 *          the in-memory list (§4.12). Every string arrives as a prop (§19.1).
 * Public API: HistoryOutcomeFilter, HistorySortKey, HistoryViewLabels,
 *          HistoryViewProps, HistoryView, filterHistory.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { formatBytes } from '@shared/utils';
import type { HistoryRecord } from '@shared/types';
import { Button, IconButton } from '@ui/components';

export type HistoryOutcomeFilter = 'all' | 'completed' | 'failed';
export type HistorySortKey = 'newest' | 'oldest' | 'title' | 'size';

export interface HistoryViewLabels {
  readonly title: string;
  readonly searchLabel: string;
  readonly searchPlaceholder: string;
  readonly outcomeLabel: string;
  readonly outcomes: Readonly<Record<HistoryOutcomeFilter, string>>;
  readonly sortLabel: string;
  readonly sorts: Readonly<Record<HistorySortKey, string>>;
  readonly count: (total: number) => string;
  readonly empty: string;
  readonly noMatches: string;
  readonly disabled: string;
  readonly delete: string;
  readonly clear: string;
  readonly clearHint: string;
  readonly export: string;
  readonly exportHint: string;
  readonly listLabel: string;
  readonly fields: {
    readonly outcome: string;
    readonly size: string;
    readonly host: string;
    readonly when: string;
    readonly filename: string;
  };
}

export interface HistoryViewProps {
  readonly records: readonly HistoryRecord[];
  /** False when "Keep history" is off, so the view explains why it is empty (§4.9). */
  readonly enabled: boolean;
  readonly labels: HistoryViewLabels;
  readonly onDelete: (id: string) => void;
  readonly onClear: () => void;
  readonly onExport: () => void;
  readonly locale?: string;
}

/** Apply the search and outcome filter, then the sort. Pure and deterministic. */
export function filterHistory(
  records: readonly HistoryRecord[],
  search: string,
  outcome: HistoryOutcomeFilter,
  sort: HistorySortKey,
): readonly HistoryRecord[] {
  const text = search.trim().toLowerCase();
  const matched = records.filter((record) => {
    if (outcome !== 'all' && record.outcome !== outcome) {
      return false;
    }
    if (text === '') {
      return true;
    }
    return [record.title, record.originHost, record.container ?? '', record.filename]
      .join(' ')
      .toLowerCase()
      .includes(text);
  });
  return [...matched].sort((a, b) => {
    switch (sort) {
      case 'oldest':
        return a.timestamp - b.timestamp || a.id.localeCompare(b.id);
      case 'title':
        return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
      case 'size':
        // An unknown size sinks in both directions — absent is not "small" (§2.8).
        return (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1) || a.id.localeCompare(b.id);
      default:
        return b.timestamp - a.timestamp || a.id.localeCompare(b.id);
    }
  });
}

const OUTCOMES: readonly HistoryOutcomeFilter[] = ['all', 'completed', 'failed'];
const SORTS: readonly HistorySortKey[] = ['newest', 'oldest', 'title', 'size'];

export function HistoryView(props: HistoryViewProps): ReactNode {
  const { labels, records } = props;
  const [search, setSearch] = useState('');
  const [outcome, setOutcome] = useState<HistoryOutcomeFilter>('all');
  const [sort, setSort] = useState<HistorySortKey>('newest');

  const visible = useMemo(
    () => filterHistory(records, search, outcome, sort),
    [records, search, outcome, sort],
  );
  const when = useMemo(
    () => new Intl.DateTimeFormat(props.locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [props.locale],
  );

  return (
    <div className="adl-history">
      <div className="adl-history__toolbar">
        <label className="adl-field adl-field--search">
          <span className="adl-visually-hidden">{labels.searchLabel}</span>
          <input
            type="search"
            className="adl-input"
            placeholder={labels.searchPlaceholder}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </label>
        <label className="adl-field">
          <span className="adl-visually-hidden">{labels.outcomeLabel}</span>
          <select
            className="adl-select"
            value={outcome}
            onChange={(event) => {
              setOutcome(event.target.value as HistoryOutcomeFilter);
            }}
          >
            {OUTCOMES.map((value) => (
              <option key={value} value={value}>
                {labels.outcomes[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="adl-field">
          <span className="adl-visually-hidden">{labels.sortLabel}</span>
          <select
            className="adl-select"
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as HistorySortKey);
            }}
          >
            {SORTS.map((value) => (
              <option key={value} value={value}>
                {labels.sorts[value]}
              </option>
            ))}
          </select>
        </label>
        <p className="adl-history__count" aria-live="polite">
          {labels.count(visible.length)}
        </p>
      </div>

      <div className="adl-history__actions">
        <Button
          variant="tonal"
          icon="download"
          disabled={records.length === 0}
          disabledReason={labels.empty}
          onClick={props.onExport}
          ariaLabel={`${labels.export} — ${labels.exportHint}`}
        >
          {labels.export}
        </Button>
        <Button
          variant="text"
          icon="clear"
          disabled={records.length === 0}
          disabledReason={labels.empty}
          onClick={props.onClear}
          ariaLabel={`${labels.clear} — ${labels.clearHint}`}
        >
          {labels.clear}
        </Button>
      </div>

      {records.length === 0 ? (
        <p className="adl-history__empty">{props.enabled ? labels.empty : labels.disabled}</p>
      ) : visible.length === 0 ? (
        <p className="adl-history__empty">{labels.noMatches}</p>
      ) : (
        <ul className="adl-history__list" aria-label={labels.listLabel}>
          {visible.map((record) => {
            const size = formatBytes(record.sizeBytes, props.locale);
            return (
              <li className="adl-history__item" key={record.id}>
                <div className="adl-history__item-main">
                  <p className="adl-history__item-title" title={record.title}>
                    {record.title}
                  </p>
                  <dl className="adl-card__facts">
                    <div className="adl-card__fact">
                      <dt className="adl-visually-hidden">{labels.fields.outcome}</dt>
                      <dd>{labels.outcomes[record.outcome]}</dd>
                    </div>
                    {size !== undefined && (
                      <div className="adl-card__fact">
                        <dt className="adl-visually-hidden">{labels.fields.size}</dt>
                        <dd>{size}</dd>
                      </div>
                    )}
                    <div className="adl-card__fact">
                      <dt className="adl-visually-hidden">{labels.fields.host}</dt>
                      <dd>{record.originHost}</dd>
                    </div>
                    <div className="adl-card__fact">
                      <dt className="adl-visually-hidden">{labels.fields.when}</dt>
                      <dd>{when.format(new Date(record.timestamp))}</dd>
                    </div>
                    <div className="adl-card__fact">
                      <dt className="adl-visually-hidden">{labels.fields.filename}</dt>
                      <dd>{record.filename}</dd>
                    </div>
                  </dl>
                </div>
                <IconButton
                  icon="remove"
                  label={`${labels.delete}: ${record.title}`}
                  onClick={() => {
                    props.onDelete(record.id);
                  }}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
