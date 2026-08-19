import { describe, expect, it } from 'vitest';
import { assertNever, isDefined } from '@shared/utils';

describe('shared/utils', () => {
  it('isDefined narrows out null and undefined', () => {
    expect(isDefined(0)).toBe(true);
    expect(isDefined('')).toBe(true);
    expect(isDefined(null)).toBe(false);
    expect(isDefined(undefined)).toBe(false);
  });

  it('assertNever throws when reached', () => {
    // Cast is confined to the test; production callers reach this only via an
    // exhaustive switch where the value type is genuinely `never`.
    expect(() => assertNever('unexpected' as never)).toThrow(/Unexpected value/);
  });
});
