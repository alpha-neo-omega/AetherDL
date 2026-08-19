/**
 * Module: ui/design-system
 * Purpose: Owns Material Design 3 tokens, theming, and UI primitives consumed by
 *          all components (PROJECT_BIBLE.md §11.9–§11.15, §11.17).
 * Responsibilities: Colour/type/spacing/shape/elevation/motion tokens, the light and
 *          dark themes, live `system` theme resolution, and the reduced-motion
 *          preference. No component defines its own styles.
 * Restrictions: UI layer — depends on shared/ only; never platform/ or runtime/
 *          (§8.4). No business logic (§8.1).
 * Dependencies: react, shared/types, shared/utils.
 * Public API: token values and helpers (./tokens), theming (./theme).
 */
export {
  contrastRatio,
  cssVariables,
  schemeFor,
  DARK_SCHEME,
  ELEVATION,
  LIGHT_SCHEME,
  MOTION,
  SHAPE,
  SPACING,
  STATE_LAYER,
  TYPE_SCALE,
  type ColorScheme,
  type ThemeMode,
} from './tokens';

export {
  createMediaPreferences,
  ThemeProvider,
  type MediaPreferences,
  type ThemeProviderProps,
} from './theme';
