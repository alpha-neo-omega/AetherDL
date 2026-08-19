/**
 * Module: ui/design-system (tokens)
 * Purpose: The Material Design 3 token system — the single source of colour, type,
 *          spacing, shape, elevation and motion values for every AetherDL surface
 *          (PROJECT_BIBLE.md §11.9–§11.15, §11.17). Tokens are the ONLY way colour
 *          is used in the UI; no component defines its own palette.
 * Restrictions: UI layer — pure data plus pure helpers. No React, no DOM, no domain
 *          logic (§8.1). The colour roles are derived from the ratified brand seed
 *          mirrored in `shared/tokens` so the badge and the UI stay one system.
 *          Every foreground/background pair here is asserted against WCAG AA in the
 *          accessibility tests (§17.4, §16.6).
 * Public API: ColorScheme, ThemeMode, LIGHT_SCHEME, DARK_SCHEME, TYPE_SCALE,
 *          SPACING, SHAPE, ELEVATION, STATE_LAYER, MOTION, contrastRatio,
 *          schemeFor, cssVariables.
 */
import type { ThemeMode } from '@shared/types';

export type { ThemeMode } from '@shared/types';

/** The MD3 colour roles AetherDL uses (§11.13). */
export interface ColorScheme {
  readonly primary: string;
  readonly onPrimary: string;
  readonly primaryContainer: string;
  readonly onPrimaryContainer: string;
  readonly secondaryContainer: string;
  readonly onSecondaryContainer: string;
  readonly surface: string;
  readonly onSurface: string;
  readonly surfaceContainer: string;
  readonly surfaceContainerHigh: string;
  readonly surfaceVariant: string;
  readonly onSurfaceVariant: string;
  readonly outline: string;
  readonly outlineVariant: string;
  readonly error: string;
  readonly onError: string;
  readonly errorContainer: string;
  readonly onErrorContainer: string;
  readonly success: string;
  readonly onSuccessContainer: string;
  readonly successContainer: string;
  /** Focus ring colour; high contrast against both surface and container (§17.3). */
  readonly focusRing: string;
  readonly scrim: string;
}

/** Light theme (§11.15). */
export const LIGHT_SCHEME: ColorScheme = {
  primary: '#33489B',
  onPrimary: '#FFFFFF',
  primaryContainer: '#DDE1FF',
  onPrimaryContainer: '#001259',
  secondaryContainer: '#E0E1F4',
  onSecondaryContainer: '#181A2C',
  surface: '#FBF8FF',
  onSurface: '#1A1B21',
  surfaceContainer: '#EFEDF4',
  surfaceContainerHigh: '#E9E7EF',
  surfaceVariant: '#E2E1EC',
  onSurfaceVariant: '#45464F',
  outline: '#5C5D67',
  outlineVariant: '#C6C5D0',
  error: '#B3261E',
  onError: '#FFFFFF',
  errorContainer: '#FFDAD6',
  onErrorContainer: '#410002',
  success: '#16610E',
  successContainer: '#CDEEC3',
  onSuccessContainer: '#052100',
  focusRing: '#33489B',
  scrim: '#000000',
};

/** Dark theme (§11.14). Elevation reads through tonal surface colour, not shadow. */
export const DARK_SCHEME: ColorScheme = {
  primary: '#B9C3FF',
  onPrimary: '#00218C',
  primaryContainer: '#1A2F82',
  onPrimaryContainer: '#DDE1FF',
  secondaryContainer: '#3F4152',
  onSecondaryContainer: '#DFE0F5',
  surface: '#121318',
  onSurface: '#E4E1E9',
  surfaceContainer: '#1F1F25',
  surfaceContainerHigh: '#292A2F',
  surfaceVariant: '#45464F',
  onSurfaceVariant: '#C6C5D0',
  outline: '#90909A',
  outlineVariant: '#45464F',
  error: '#FFB4AB',
  onError: '#690005',
  errorContainer: '#93000A',
  onErrorContainer: '#FFDAD6',
  success: '#B2D5A6',
  successContainer: '#1F4A17',
  onSuccessContainer: '#CDEEC3',
  focusRing: '#B9C3FF',
  scrim: '#000000',
};

/** MD3 type scale roles used by the popup (§11.8). Sizes in rem, line heights unitless. */
export const TYPE_SCALE = {
  titleMedium: { size: '1rem', lineHeight: '1.5', weight: '600', tracking: '0.009rem' },
  titleSmall: { size: '0.875rem', lineHeight: '1.43', weight: '600', tracking: '0.006rem' },
  bodyMedium: { size: '0.875rem', lineHeight: '1.43', weight: '400', tracking: '0.016rem' },
  bodySmall: { size: '0.75rem', lineHeight: '1.33', weight: '400', tracking: '0.025rem' },
  labelLarge: { size: '0.875rem', lineHeight: '1.43', weight: '600', tracking: '0.006rem' },
  labelSmall: { size: '0.6875rem', lineHeight: '1.45', weight: '600', tracking: '0.031rem' },
} as const;

/** The 8dp grid with 4dp sub-steps (§11.9). No ad-hoc spacing anywhere else. */
export const SPACING = {
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '24px',
  xxl: '32px',
} as const;

/** MD3 corner shapes (§11.12). */
export const SHAPE = {
  none: '0',
  extraSmall: '4px',
  small: '8px',
  medium: '12px',
  large: '16px',
  full: '999px',
} as const;

/** Elevation as tonal surface + shadow pairs (§11.12). */
export const ELEVATION = {
  level0: 'none',
  level1: '0 1px 2px rgba(0, 0, 0, 0.3), 0 1px 3px 1px rgba(0, 0, 0, 0.15)',
  level2: '0 1px 2px rgba(0, 0, 0, 0.3), 0 2px 6px 2px rgba(0, 0, 0, 0.15)',
} as const;

/** MD3 state-layer opacities (§11.13). */
export const STATE_LAYER = {
  hover: '0.08',
  focus: '0.1',
  pressed: '0.1',
  disabled: '0.38',
} as const;

/** Short, MD3-appropriate durations; disabled under reduced motion (§11.11, §17.7). */
export const MOTION = {
  short: '120ms',
  medium: '200ms',
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
} as const;

function channel(value: number): number {
  const ratio = value / 255;
  return ratio <= 0.04045 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of a `#rrggbb` colour (WCAG 2.1). */
function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const red = channel((value >> 16) & 0xff);
  const green = channel((value >> 8) & 0xff);
  const blue = channel(value & 0xff);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/**
 * WCAG 2.1 contrast ratio between two `#rrggbb` colours (§17.4). Used by the
 * accessibility tests to hold every token pair to AA.
 */
export function contrastRatio(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Resolve a theme mode to a scheme; `system` follows the OS preference (§11.15). */
export function schemeFor(mode: ThemeMode, prefersDark: boolean): ColorScheme {
  if (mode === 'dark') {
    return DARK_SCHEME;
  }
  if (mode === 'light') {
    return LIGHT_SCHEME;
  }
  return prefersDark ? DARK_SCHEME : LIGHT_SCHEME;
}

/**
 * Flatten a scheme plus the static scales into CSS custom properties. The stylesheet
 * consumes only these variables, so colour values live in exactly one place (§11.17).
 */
export function cssVariables(scheme: ColorScheme): Readonly<Record<string, string>> {
  const vars: Record<string, string> = {};
  for (const [role, value] of Object.entries(scheme)) {
    vars[`--adl-color-${kebab(role)}`] = value;
  }
  for (const [name, value] of Object.entries(SPACING)) {
    vars[`--adl-space-${name}`] = value;
  }
  for (const [name, value] of Object.entries(SHAPE)) {
    vars[`--adl-shape-${kebab(name)}`] = value;
  }
  for (const [name, value] of Object.entries(ELEVATION)) {
    vars[`--adl-elevation-${name}`] = value;
  }
  for (const [name, value] of Object.entries(STATE_LAYER)) {
    vars[`--adl-state-${name}`] = value;
  }
  for (const [name, value] of Object.entries(MOTION)) {
    vars[`--adl-motion-${name}`] = value;
  }
  for (const [role, spec] of Object.entries(TYPE_SCALE)) {
    const prefix = `--adl-type-${kebab(role)}`;
    vars[`${prefix}-size`] = spec.size;
    vars[`${prefix}-line-height`] = spec.lineHeight;
    vars[`${prefix}-weight`] = spec.weight;
    vars[`${prefix}-tracking`] = spec.tracking;
  }
  return vars;
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
