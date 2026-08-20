/**
 * Module: core/download/stream (rendition selection)
 * Purpose: Decide WHICH rendition of a multi-quality stream to download
 *          (PROJECT_BIBLE.md §10.6). Until now assembly always took the highest
 *          bandwidth on offer, which against real manifests means a 4K, 15 Mbps copy
 *          of a clip the user wanted at 720p — and, where variants differ in audio
 *          codec, an AC-3 track chosen by accident rather than on purpose.
 * Restrictions: Domain layer — pure. Bandwidth and height in, one choice out: no I/O,
 *          no browser globals, no policy beyond what the caller asked for. Selection
 *          NEVER decides whether a stream is downloadable; refusals (encryption above
 *          all) are decided before this is reached (§6, ADR-005).
 * Dependencies: shared/types.
 * Public API: STREAM_QUALITY_PREFERENCES (re-exported), Rendition, StreamSelection,
 *            heightCapOf, selectRendition, isPreferredRendition.
 */
import { STREAM_QUALITY_PREFERENCES } from '@shared/constants';
import type { StreamQualityPreference } from '@shared/types';

/**
 * The preference list, re-exported from where it is declared (§8.16). One list, so a
 * value the settings validator accepts is always a value selection understands.
 */
export { STREAM_QUALITY_PREFERENCES };

/**
 * The shape selection needs from a rendition: an id to return, and whatever the
 * manifest happened to declare. Both HLS variants and DASH representations reduce to
 * this, so one function decides for both and cannot drift between them.
 */
export interface Rendition {
  readonly id: string;
  readonly bandwidth?: number;
  readonly width?: number;
  readonly height?: number;
  readonly codecs?: string;
}

/**
 * What the caller wants. A pinned `renditionId` is the user's explicit choice and
 * wins; the preference is the standing default from settings.
 */
export interface StreamSelection {
  readonly renditionId?: string;
  readonly preference?: StreamQualityPreference;
}

/** The height a preference caps at, or undefined for the open-ended ones. */
export function heightCapOf(preference: StreamQualityPreference | undefined): number | undefined {
  if (preference === undefined || preference === 'highest' || preference === 'lowest') {
    return undefined;
  }
  const parsed = Number(preference);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Bandwidth ordering, with a missing bandwidth treated as the worst on offer. */
function byBandwidthDescending(left: Rendition, right: Rendition): number {
  return (right.bandwidth ?? 0) - (left.bandwidth ?? 0);
}

/**
 * Rank two renditions for a capped preference: taller first, then higher bandwidth.
 *
 * Height leads because that is what the user named. Two renditions at the same height
 * differ only in bitrate, and there the better copy is the one to take.
 */
function byHeightThenBandwidth(left: Rendition, right: Rendition): number {
  const heights = (right.height ?? 0) - (left.height ?? 0);
  return heights !== 0 ? heights : byBandwidthDescending(left, right);
}

/**
 * Choose one rendition.
 *
 * Order of authority: a pinned id, then the preference, then the highest bandwidth —
 * which is also what happens when a manifest declares no heights at all, because a
 * cap cannot be applied to something that never said how tall it is.
 *
 * A cap that excludes everything does NOT fail: the smallest rendition is taken
 * instead. Refusing to download a stream because every copy of it is bigger than the
 * user's preference would be obeying the letter of a setting against its intent.
 */
export function selectRendition(
  renditions: readonly Rendition[],
  selection: StreamSelection = {},
): Rendition | undefined {
  if (renditions.length === 0) {
    return undefined;
  }
  if (selection.renditionId !== undefined) {
    const pinned = renditions.find((rendition) => rendition.id === selection.renditionId);
    if (pinned !== undefined) {
      return pinned;
    }
    // A pinned id that is no longer in the manifest — it was re-packaged between the
    // pick and the download — falls through to the preference rather than failing the
    // download over a stale choice.
  }
  const ordered = [...renditions];
  const preference = selection.preference;

  if (preference === 'lowest') {
    return ordered.sort((left, right) => byBandwidthDescending(right, left))[0];
  }
  const cap = heightCapOf(preference);
  if (cap !== undefined) {
    const withinCap = ordered.filter(
      (rendition) => rendition.height !== undefined && rendition.height <= cap,
    );
    if (withinCap.length > 0) {
      return withinCap.sort(byHeightThenBandwidth)[0];
    }
    const measured = ordered.filter((rendition) => rendition.height !== undefined);
    if (measured.length > 0) {
      // Everything is taller than the cap: take the smallest, not nothing.
      return measured.sort((left, right) => byHeightThenBandwidth(right, left))[0];
    }
  }
  return ordered.sort(byBandwidthDescending)[0];
}

/** Whether this rendition is the one {@link selectRendition} would take. */
export function isPreferredRendition(
  rendition: Rendition,
  renditions: readonly Rendition[],
  selection: StreamSelection = {},
): boolean {
  return selectRendition(renditions, selection)?.id === rendition.id;
}
