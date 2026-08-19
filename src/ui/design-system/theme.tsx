/**
 * Module: ui/design-system (theming)
 * Purpose: Resolve the active theme and publish the Material Design 3 token system
 *          to the surface (PROJECT_BIBLE.md §11.13–§11.15). `system` follows the OS
 *          preference live; `light`/`dark` pin the scheme. Also resolves the
 *          reduced-motion preference (§17.7).
 * Restrictions: UI layer — no platform/ or runtime/ imports (§8.4). The media-query
 *          source is injected so the provider is testable and degrades cleanly where
 *          `matchMedia` is unavailable (§7.2). Tokens are published as custom
 *          properties on the document root and consumed only by the stylesheet, so a
 *          theme change restyles without re-rendering components (§11.17). Every
 *          subscription and every property is released on unmount (§12.7).
 * Public API: MediaPreferences, createMediaPreferences, ThemeProvider.
 */
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { Unsubscribe } from '@shared/utils';
import type { ReducedMotionPreference } from '@shared/types';
import { cssVariables, schemeFor, type ThemeMode } from './tokens';

const DARK_QUERY = '(prefers-color-scheme: dark)';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** A live source of OS/browser display preferences. */
export interface MediaPreferences {
  matches(query: string): boolean;
  subscribe(query: string, listener: () => void): Unsubscribe;
}

/**
 * The default source over `matchMedia`. Where the API is missing (older engines,
 * non-DOM environments) every query reports `false` and nothing is subscribed, so
 * the UI degrades to the light theme with motion enabled rather than failing.
 */
export function createMediaPreferences(): MediaPreferences {
  const query = (value: string): MediaQueryList | undefined =>
    typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(value) : undefined;

  return {
    matches(value: string): boolean {
      return query(value)?.matches ?? false;
    },
    subscribe(value: string, listener: () => void): Unsubscribe {
      const list = query(value);
      if (list === undefined || typeof list.addEventListener !== 'function') {
        return () => undefined;
      }
      list.addEventListener('change', listener);
      return () => {
        list.removeEventListener('change', listener);
      };
    },
  };
}

export interface ThemeProviderProps {
  /** Theme setting (§4.9); defaults to the normative `system`. */
  readonly mode?: ThemeMode;
  /**
   * Reduced-motion setting (§4.9). `system` follows `prefers-reduced-motion`;
   * `on`/`off` pin it, because the user's explicit choice wins over the OS (§17.7).
   */
  readonly reducedMotion?: ReducedMotionPreference;
  readonly media?: MediaPreferences;
  readonly children: ReactNode;
}

function useMediaQuery(media: MediaPreferences, query: string): boolean {
  const subscribe = useMemo(
    () => (listener: () => void) => media.subscribe(query, listener),
    [media, query],
  );
  const snapshot = useMemo(() => () => media.matches(query), [media, query]);
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

export function ThemeProvider(props: ThemeProviderProps): ReactNode {
  const mode = props.mode ?? 'system';
  const media = useMemo(() => props.media ?? createMediaPreferences(), [props.media]);
  const motionPreference = props.reducedMotion ?? 'system';
  const prefersDark = useMediaQuery(media, DARK_QUERY);
  const prefersReducedMotion = useMediaQuery(media, REDUCED_MOTION_QUERY);
  // The user's explicit choice wins over the OS preference (§4.9, §17.7).
  const reducedMotion =
    motionPreference === 'system' ? prefersReducedMotion : motionPreference === 'on';
  const resolved: 'light' | 'dark' = mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode;

  useEffect(() => {
    const element = globalThis.document?.documentElement;
    if (element === undefined || element === null) {
      return undefined;
    }
    const variables = cssVariables(schemeFor(mode, prefersDark));
    for (const [name, value] of Object.entries(variables)) {
      element.style.setProperty(name, value);
    }
    // `color-scheme` keeps native form controls and scrollbars in step (§11.14).
    element.style.setProperty('color-scheme', resolved);
    element.dataset['theme'] = resolved;
    element.dataset['reducedMotion'] = String(reducedMotion);
    return () => {
      for (const name of Object.keys(variables)) {
        element.style.removeProperty(name);
      }
      element.style.removeProperty('color-scheme');
      delete element.dataset['theme'];
      delete element.dataset['reducedMotion'];
    };
  }, [mode, prefersDark, reducedMotion, resolved]);

  return <>{props.children}</>;
}
