/**
 * Module: shared/utils (formatting)
 * Purpose: Locale-aware presentation formatters for byte sizes, durations and
 *          percentages (PROJECT_BIBLE.md §8.16 utils, §19.3 formatting).
 * Responsibilities: Pure, side-effect-free conversion of domain numbers into
 *          display strings using `Intl`; no manual locale-specific string building.
 * Restrictions: Leaf layer — no internal dependencies (§8.16). Honest output: an
 *          unknown value yields `undefined` so callers render "Unknown" rather than
 *          a fabricated figure (§2.8, §4.2).
 * Dependencies: none.
 * Public API: formatBytes, formatDuration, formatPercent.
 */

const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;

/**
 * Format a byte count with the largest sensible unit, e.g. `4.2 MB`. Returns
 * `undefined` for unknown/invalid input so the caller can show "Unknown" (§4.2).
 */
export function formatBytes(bytes: number | undefined, locale?: string): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return undefined;
  }
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = BYTE_UNITS[unitIndex] ?? 'byte';
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: unitIndex === 0 ? 0 : 1,
  }).format(value);
}

/** Format seconds as `h:mm:ss` (or `m:ss` under an hour). `undefined` when unknown. */
export function formatDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/** Format a 0..1 ratio as a locale-aware percentage. `undefined` when unknown. */
export function formatPercent(ratio: number | undefined, locale?: string): string | undefined {
  if (ratio === undefined || !Number.isFinite(ratio)) {
    return undefined;
  }
  const clamped = Math.min(1, Math.max(0, ratio));
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(
    clamped,
  );
}
