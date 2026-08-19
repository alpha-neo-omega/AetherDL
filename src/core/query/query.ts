/**
 * Module: core/query (implementation)
 * Purpose: The local filter / sort / search engine over detected media
 *          (PROJECT_BIBLE.md §4.12). Search matches title, host and type;
 *          filtering narrows by kind, container and host.
 * Restrictions: Domain layer — pure and synchronous over in-memory data; no
 *          network, no browser APIs (§4.12, §8.4). Deterministic: equal items keep
 *          a stable order via an id tiebreak, and items missing the sort key always
 *          sort last so results never reshuffle between runs.
 * Public API: createQueryEngine.
 */
import type { MediaItem } from '@shared/types';
import type { FilterSpec, QueryEngine, SortSpec } from '@core/query';

function haystack(item: MediaItem): string {
  return [item.title, item.originHost, item.container ?? '', item.mimeType ?? '']
    .join(' ')
    .toLowerCase();
}

function matches(item: MediaItem, filter: FilterSpec): boolean {
  if (filter.kind !== undefined && item.kind !== filter.kind) {
    return false;
  }
  if (
    filter.container !== undefined &&
    (item.container ?? '').toLowerCase() !== filter.container.toLowerCase()
  ) {
    return false;
  }
  if (filter.host !== undefined && item.originHost !== filter.host) {
    return false;
  }
  const text = filter.text?.trim().toLowerCase();
  if (text !== undefined && text !== '' && !haystack(item).includes(text)) {
    return false;
  }
  return true;
}

/** Exhaustive by type: a new sort key fails to compile until it is read here. */
const SORT_VALUE: Readonly<
  Record<SortSpec['key'], (item: MediaItem) => string | number | undefined>
> = {
  title: (item) => item.title,
  sizeBytes: (item) => item.sizeBytes,
  durationSec: (item) => item.durationSec,
  score: (item) => item.score,
  discoveredAt: (item) => item.discoveredAt,
};

function compare(a: MediaItem, b: MediaItem, sort: SortSpec): number {
  const read = SORT_VALUE[sort.key];
  const left = read(a);
  const right = read(b);
  // Unknown values always sink, in both directions — an absent field is not "small".
  if (left === undefined && right === undefined) {
    return a.id.localeCompare(b.id);
  }
  if (left === undefined) {
    return 1;
  }
  if (right === undefined) {
    return -1;
  }
  const ordering =
    typeof left === 'string' && typeof right === 'string'
      ? left.localeCompare(right)
      : Number(left) - Number(right);
  const directed = sort.direction === 'desc' ? -ordering : ordering;
  return directed !== 0 ? directed : a.id.localeCompare(b.id);
}

export function createQueryEngine(): QueryEngine {
  return {
    apply(items: readonly MediaItem[], filter: FilterSpec, sort: SortSpec): readonly MediaItem[] {
      return items.filter((item) => matches(item, filter)).sort((a, b) => compare(a, b, sort));
    },
  };
}
