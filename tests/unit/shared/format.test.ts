import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, formatPercent } from '@shared/utils';

// A fixed locale keeps the assertions independent of the machine (§16.8).
const LOCALE = 'en-US';

describe('shared/utils formatting', () => {
  it('formats byte counts with the largest sensible unit', () => {
    expect(formatBytes(512, LOCALE)).toBe('512 byte');
    expect(formatBytes(2048, LOCALE)).toBe('2 kB');
    expect(formatBytes(5 * 1024 * 1024, LOCALE)).toBe('5 MB');
    expect(formatBytes(3.5 * 1024 * 1024 * 1024, LOCALE)).toBe('3.5 GB');
    expect(formatBytes(2 * 1024 ** 4, LOCALE)).toBe('2 TB');
  });

  it('returns undefined for unknown or invalid sizes rather than inventing one', () => {
    expect(formatBytes(undefined, LOCALE)).toBeUndefined();
    expect(formatBytes(Number.NaN, LOCALE)).toBeUndefined();
    expect(formatBytes(-1, LOCALE)).toBeUndefined();
  });

  it('formats durations as a clock', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(9)).toBe('0:09');
    expect(formatDuration(204)).toBe('3:24');
    expect(formatDuration(3661)).toBe('1:01:01');
    expect(formatDuration(59.6)).toBe('1:00');
  });

  it('returns undefined for unknown or invalid durations', () => {
    expect(formatDuration(undefined)).toBeUndefined();
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(formatDuration(-5)).toBeUndefined();
  });

  it('formats and clamps percentages', () => {
    expect(formatPercent(0, LOCALE)).toBe('0%');
    expect(formatPercent(0.42, LOCALE)).toBe('42%');
    expect(formatPercent(1, LOCALE)).toBe('100%');
    expect(formatPercent(2, LOCALE)).toBe('100%');
    expect(formatPercent(-1, LOCALE)).toBe('0%');
    expect(formatPercent(undefined, LOCALE)).toBeUndefined();
  });
});
