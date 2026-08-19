/**
 * Module: runtime/settings (entry)
 * Purpose: Settings surface entry and composition root — mounts `ui/settings` with
 *          the concrete runtime client injected (PROJECT_BIBLE.md §11.2).
 * Restrictions: Thin surface — mounting/lifecycle and dependency injection only; no
 *          domain logic (§8.1). Coverage-excluded (it touches the ambient browser
 *          namespace and the DOM root); the settings logic lives in `ui/` and the
 *          adapter in ./client, both unit-tested.
 */
import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { createBrowser } from '@platform/browser/factory';
import { resolveSettingsCatalog, SettingsApp } from '@ui/settings';
import '@ui/design-system/styles.css';
import { createSettingsRuntimeClient } from '@runtime/settings/client';

const container = document.getElementById('app');
if (container !== null) {
  const browser = createBrowser();
  const client = createSettingsRuntimeClient(browser);
  // Strings come from the packaged `_locales` catalogue, falling back to the
  // built-in English text for anything the active locale omits (§19.1, §19.2).
  const messages = resolveSettingsCatalog((name) => browser.i18n.getMessage(name));
  createRoot(container).render(createElement(SettingsApp, { client, messages }));
}
