/**
 * Module: runtime/content (resource timeline)
 * Purpose: Turn the page's own Resource Timing entries into the bounded list of
 *          observations the background identifies media from (PROJECT_BIBLE.md §8.10,
 *          §9.1, ADR-012).
 * Restrictions: Pure — entries in, observations out. It issues no request, reads no
 *          browser global, and intercepts nothing; the entry supplies the timeline
 *          (§8.10). Deliberately NOT in the entry module: this is where a cap decides
 *          whether a stream is findable at all, and that decision has to be testable.
 * Dependencies: shared/constants, shared/types, shared/utils.
 * Public API: TimelineEntry, ResourceTimeline, isInterestingInitiator,
 *          createResourceTimeline.
 */
import { MAX_OBSERVED_RESOURCES } from '@shared/constants';
import type { WireObservedResource } from '@shared/types';
import { manifestTypeFromUrl } from '@shared/utils';

/**
 * The part of a `PerformanceResourceTiming` this reads. Structural, so the tests can
 * hand it plain objects and the entry can hand it the real thing.
 */
export interface TimelineEntry {
  readonly name: string;
  readonly initiatorType?: string;
  readonly transferSize?: number;
  readonly encodedBodySize?: number;
}

/**
 * Resource Timing initiators that can carry a stream a player fetched itself.
 *
 * A page loads hundreds of resources; only the script-driven ones can be the playlist
 * a MediaSource is being fed from. Reporting the rest would fill the message with
 * images and fonts (§9.1, ADR-012).
 */
const INTERESTING_INITIATORS = new Set(['xmlhttprequest', 'fetch', 'video', 'audio', 'other', '']);

/** Whether a Resource Timing initiator is one a player's own fetch could carry. */
export function isInterestingInitiator(initiatorType: string | undefined): boolean {
  return INTERESTING_INITIATORS.has((initiatorType ?? '').toLowerCase());
}

export interface ResourceTimeline {
  /**
   * Fold a timeline reading into what has been observed, and return the whole of it.
   * Safe to call repeatedly with the same entries: it converges rather than churning.
   */
  harvest(entries: readonly TimelineEntry[]): readonly WireObservedResource[];
}

/**
 * Accumulate what the page has fetched, keeping the EARLIEST observations.
 *
 * Two facts decide this, and 1.8.2 got the second one backwards.
 *
 * First, Resource Timing is a fixed-size buffer that stops recording when it is full:
 * new entries are dropped, existing ones are kept. So a page playing a long video ends
 * up with a frozen timeline whose entries are the FIRST couple of hundred requests it
 * made — and a player fetches its playlist before it fetches the segments. The playlist
 * therefore lives at the HEAD of that list. (Some players also clear the buffer
 * outright, which is why the observations are accumulated here rather than re-read: a
 * cleared timeline must not un-detect a stream that was already seen.)
 *
 * Second, the cap must therefore preserve the head. 1.8.2 evicted the oldest entry to
 * make room for each new one, which on a page with more segments than the cap allows
 * converges on the LAST N requests — every one of them a segment, with the playlist
 * evicted on the very first pass and never recoverable. That silently undetected a
 * stream that was being detected before it.
 *
 * A manifest is the exception in both directions: never evicted, and admitted even
 * when the list is full, because a playlist discovered late is the one thing worth
 * making room for.
 */
export function createResourceTimeline(
  options: { readonly maxEntries?: number } = {},
): ResourceTimeline {
  const maxEntries = options.maxEntries ?? MAX_OBSERVED_RESOURCES;
  const seen = new Map<string, WireObservedResource>();

  /** Drop the oldest entry that is not a manifest; report whether room was made. */
  const evictOldestSegment = (): boolean => {
    for (const url of seen.keys()) {
      if (manifestTypeFromUrl(url) === undefined) {
        seen.delete(url);
        return true;
      }
    }
    // Every entry names a manifest. Keeping them all beats replacing one.
    return false;
  };

  const remember = (resource: WireObservedResource): void => {
    if (seen.has(resource.url)) {
      return;
    }
    if (seen.size >= maxEntries) {
      // Full: the newcomer is turned away, because what is already here is EARLIER,
      // and earlier is where a playlist is. The single exception is a manifest, which
      // is worth evicting a segment for.
      if (manifestTypeFromUrl(resource.url) === undefined || !evictOldestSegment()) {
        return;
      }
    }
    seen.set(resource.url, resource);
  };

  return {
    harvest(entries: readonly TimelineEntry[]): readonly WireObservedResource[] {
      for (const entry of entries) {
        const initiator = (entry.initiatorType ?? '').toLowerCase();
        if (!isInterestingInitiator(initiator)) {
          continue;
        }
        const url = entry.name;
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          continue;
        }
        // A cross-origin response without Timing-Allow-Origin reports zero, which
        // means "unknown", not "empty" — it is left off rather than reported as 0.
        const size = (entry.transferSize ?? 0) || (entry.encodedBodySize ?? 0);
        remember({
          url,
          ...(initiator !== '' && { initiatorType: initiator }),
          ...(size > 0 && { sizeBytes: size }),
        });
      }
      return [...seen.values()];
    },
  };
}
