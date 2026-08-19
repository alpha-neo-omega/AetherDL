/**
 * Module: ui/popup (appearance settings hook)
 * Purpose: Follow the user's Appearance settings on the popup surface — the theme
 *          and reduced-motion choices are applied live, including when they are
 *          changed on the settings page while the popup is open (PROJECT_BIBLE.md
 *          §4.9, §11.15, §17.7).
 * Restrictions: UI layer — reads through the injected runtime port only; it owns no
 *          settings state and never writes any (§8.7, §13.2). Until the catalogue
 *          arrives it renders the normative defaults, so the surface never flashes
 *          an arbitrary appearance. The subscription is released on unmount (§12.7).
 * Public API: AppearanceSettings, useThemeSettings.
 */
import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS } from '@core/settings';
import type { ReducedMotionPreference, ThemeMode } from '@shared/types';
import type { PopupRuntimeClient } from './runtime-client';

export interface AppearanceSettings {
  readonly theme: ThemeMode;
  readonly reducedMotion: ReducedMotionPreference;
}

const DEFAULTS: AppearanceSettings = {
  theme: DEFAULT_SETTINGS.theme,
  reducedMotion: DEFAULT_SETTINGS.reducedMotion,
};

export function useThemeSettings(client: PopupRuntimeClient): AppearanceSettings {
  const [appearance, setAppearance] = useState<AppearanceSettings>(DEFAULTS);

  useEffect(() => {
    let cancelled = false;
    const apply = (settings: {
      theme: ThemeMode;
      reducedMotion: ReducedMotionPreference;
    }): void => {
      if (!cancelled) {
        setAppearance({ theme: settings.theme, reducedMotion: settings.reducedMotion });
      }
    };
    // A failure here is not worth interrupting the user for: the popup keeps the
    // normative defaults and the runtime error surface reports real problems (§20.5).
    void client.getSettings().then(apply, () => undefined);
    const unsubscribe = client.onSettingsChanged(apply);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client]);

  return appearance;
}
