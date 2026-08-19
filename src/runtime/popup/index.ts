/**
 * Module: runtime/popup (entry)
 * Purpose: Popup surface entry and composition root — mounts `ui/popup` with the
 *          concrete runtime client injected (PROJECT_BIBLE.md §8.11, §11.1).
 * Restrictions: Thin surface — mounting/lifecycle and dependency injection only; no
 *          domain logic (§8.1). Coverage-excluded (it touches the ambient browser
 *          namespace and the DOM root); the popup logic lives in `ui/` and the
 *          adapter in ./client, both unit-tested.
 */
import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { createBrowser } from '@platform/browser/factory';
import { PopupApp, resolveCatalog } from '@ui/popup';
import '@ui/design-system/styles.css';
import { createPopupRuntimeClient } from '@runtime/popup/client';

const container = document.getElementById('app');
if (container !== null) {
  const browser = createBrowser();
  const client = createPopupRuntimeClient(browser);
  // Strings come from the packaged `_locales` catalogue, falling back to the
  // built-in English text for anything the active locale omits (§19.1, §19.2).
  const messages = resolveCatalog((name) => browser.i18n.getMessage(name));
  createRoot(container).render(createElement(PopupApp, { client, messages }));
}
