/**
 * Module: platform/browser (i18n service)
 * Purpose: The typed wrapper over the WebExtension message catalogues shipped in
 *          `public/_locales/<locale>/messages.json` (PROJECT_BIBLE.md §19.1). It is
 *          the single route from a message name to localized text.
 * Restrictions: Platform layer — adapts only; it owns no strings and performs no
 *          translation. Localization is entirely local: no service is ever called
 *          at runtime (§19.5, §14.3). Where the namespace is unavailable, every
 *          lookup returns an empty string so callers fall back to their built-in
 *          English catalogue (§19.2) rather than rendering nothing.
 * Public API: I18nService, createI18nService.
 */
import type { WebExtApi } from '@platform/browser/webext';

export interface I18nService {
  /** Resolve a catalogue message name; `''` when the catalogue has no entry. */
  getMessage(name: string, substitutions?: readonly string[]): string;
  /** The active UI language as a BCP-47 tag; `en` when unknown (§19.2). */
  getUiLanguage(): string;
}

const FALLBACK_LANGUAGE = 'en';

/** Create the i18n service over a resolved WebExtension API. */
export function createI18nService(api: WebExtApi): I18nService {
  return {
    getMessage(name: string, substitutions?: readonly string[]): string {
      const i18n = api.i18n;
      if (i18n === undefined) {
        return '';
      }
      try {
        return i18n.getMessage(name, substitutions) || '';
      } catch {
        // A malformed name must not take a surface down; the caller falls back.
        return '';
      }
    },

    getUiLanguage(): string {
      const getUILanguage = api.i18n?.getUILanguage;
      if (typeof getUILanguage !== 'function') {
        return FALLBACK_LANGUAGE;
      }
      try {
        return getUILanguage() || FALLBACK_LANGUAGE;
      } catch {
        return FALLBACK_LANGUAGE;
      }
    },
  };
}
