import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  cssVariables,
  DARK_SCHEME,
  LIGHT_SCHEME,
  schemeFor,
  SPACING,
  type ColorScheme,
} from '@ui/design-system';

/** Foreground/background token pairs carrying text — WCAG AA needs ≥ 4.5:1 (§17.4). */
const TEXT_PAIRS: readonly (readonly [keyof ColorScheme, keyof ColorScheme])[] = [
  ['onSurface', 'surface'],
  ['onSurface', 'surfaceContainer'],
  ['onSurface', 'surfaceContainerHigh'],
  ['onSurfaceVariant', 'surface'],
  ['onSurfaceVariant', 'surfaceContainer'],
  ['onSurfaceVariant', 'surfaceContainerHigh'],
  ['onPrimary', 'primary'],
  ['onPrimaryContainer', 'primaryContainer'],
  ['onSecondaryContainer', 'secondaryContainer'],
  ['onError', 'error'],
  ['onErrorContainer', 'errorContainer'],
  ['onSuccessContainer', 'successContainer'],
  ['primary', 'surface'],
  ['primary', 'surfaceContainer'],
  ['primary', 'surfaceContainerHigh'],
  ['error', 'surface'],
  // Settings surface: the saved confirmation and the field help text (§11.2).
  ['success', 'surfaceContainer'],
  ['onSurfaceVariant', 'surfaceVariant'],
];

/** Non-text UI (borders, focus rings, indicators) — AA needs ≥ 3:1 (§17.4). */
const UI_PAIRS: readonly (readonly [keyof ColorScheme, keyof ColorScheme])[] = [
  ['outline', 'surface'],
  ['outline', 'surfaceContainer'],
  ['focusRing', 'surface'],
  ['focusRing', 'surfaceContainer'],
  ['primary', 'surfaceVariant'],
  ['success', 'surface'],
];

describe('ui/design-system tokens', () => {
  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
  });

  it.each([
    ['light', LIGHT_SCHEME],
    ['dark', DARK_SCHEME],
  ])('meets AA text contrast in the %s theme', (_name, scheme) => {
    for (const [foreground, background] of TEXT_PAIRS) {
      const ratio = contrastRatio(scheme[foreground], scheme[background]);
      expect(
        ratio,
        `${String(foreground)} on ${String(background)} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each([
    ['light', LIGHT_SCHEME],
    ['dark', DARK_SCHEME],
  ])('meets AA non-text contrast in the %s theme', (_name, scheme) => {
    for (const [foreground, background] of UI_PAIRS) {
      const ratio = contrastRatio(scheme[foreground], scheme[background]);
      expect(
        ratio,
        `${String(foreground)} on ${String(background)} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it('defines every colour role in both themes', () => {
    expect(Object.keys(DARK_SCHEME).sort()).toEqual(Object.keys(LIGHT_SCHEME).sort());
    for (const value of [...Object.values(LIGHT_SCHEME), ...Object.values(DARK_SCHEME)]) {
      expect(value).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it('resolves the scheme for each theme mode', () => {
    expect(schemeFor('light', true)).toBe(LIGHT_SCHEME);
    expect(schemeFor('dark', false)).toBe(DARK_SCHEME);
    expect(schemeFor('system', false)).toBe(LIGHT_SCHEME);
    expect(schemeFor('system', true)).toBe(DARK_SCHEME);
  });

  it('spaces on the 8dp grid with 4dp sub-steps', () => {
    expect(Object.values(SPACING)).toEqual(['4px', '8px', '12px', '16px', '24px', '32px']);
  });

  it('flattens a scheme and the scales into kebab-case custom properties', () => {
    const vars = cssVariables(LIGHT_SCHEME);
    expect(vars['--adl-color-on-surface-variant']).toBe(LIGHT_SCHEME.onSurfaceVariant);
    expect(vars['--adl-color-primary']).toBe(LIGHT_SCHEME.primary);
    expect(vars['--adl-space-lg']).toBe('16px');
    expect(vars['--adl-shape-extra-small']).toBe('4px');
    expect(vars['--adl-state-hover']).toBe('0.08');
    expect(vars['--adl-elevation-level1']).toContain('rgba');
    expect(vars['--adl-motion-short']).toBe('120ms');
    expect(vars['--adl-type-body-medium-size']).toBe('0.875rem');
    expect(vars['--adl-type-title-medium-weight']).toBe('600');
    expect(Object.keys(vars).every((name) => name.startsWith('--adl-'))).toBe(true);
  });
});
