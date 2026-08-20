// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@core/settings';
import type { MediaPreferences } from '@ui/design-system';
import { SettingsApp, useSettingsClient } from '@ui/settings';
import {
  byName,
  click,
  flush,
  render,
  renderAsync,
  requireByName,
  selectOption,
  texts,
  type Rendered,
} from '../_render';
import type { ReactNode } from 'react';
import { createFakeSettingsClient, historyRecord, type FakeSettingsClient } from './_fixtures';

/** A component that consumes the port without the provider above it. */
function Consumer(): ReactNode {
  useSettingsClient();
  return null;
}

const NO_MEDIA_QUERIES: MediaPreferences = {
  matches: () => false,
  subscribe: () => () => undefined,
};

const ALWAYS_DARK: MediaPreferences = {
  matches: (query) => query.includes('dark'),
  subscribe: () => () => undefined,
};

async function mount(
  fake: FakeSettingsClient,
  media: MediaPreferences = NO_MEDIA_QUERIES,
): Promise<Rendered> {
  return renderAsync(<SettingsApp client={fake.client} media={media} locale="en-US" />);
}

afterEach(() => {
  document.documentElement.removeAttribute('style');
  delete document.documentElement.dataset['theme'];
  delete document.documentElement.dataset['reducedMotion'];
});

/** Find an element by its exact id without relying on selector escaping. */
function byId(container: HTMLElement, id: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>('[id]')].find((element) => element.id === id);
}

/** The labelled control for a field, found through its visible label. */
function field(view: Rendered, label: string): HTMLElement {
  const labelEl = [...view.container.querySelectorAll('label')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (labelEl === undefined) {
    throw new Error(`No field labelled "${label}"`);
  }
  const control = byId(view.container, labelEl.htmlFor);
  if (control === undefined) {
    throw new Error(`Label "${label}" points at no control`);
  }
  return control;
}

describe('ui/settings SettingsApp — catalogue', () => {
  it('shows the loading state until the catalogue arrives', async () => {
    const fake = createFakeSettingsClient();
    const view = render(<SettingsApp client={fake.client} media={NO_MEDIA_QUERIES} />);
    expect(view.container.querySelector('.adl-status--loading')).not.toBeNull();
    await flush();
    expect(view.container.querySelector('.adl-status--loading')).toBeNull();
    view.unmount();
  });

  it('renders every ratified section', async () => {
    const view = await mount(createFakeSettingsClient());
    expect(texts(view.container, '.adl-settings__heading')).toEqual([
      'Appearance',
      'Downloads',
      'Detection',
      'Notifications',
      'History',
      'Permissions',
      'About',
    ]);
    view.unmount();
  });

  it('shows every setting at its normative default', async () => {
    const view = await mount(createFakeSettingsClient());
    expect((field(view, 'Theme') as HTMLSelectElement).value).toBe('system');
    expect((field(view, 'Maximum concurrent downloads') as HTMLInputElement).value).toBe('3');
    expect((field(view, 'Maximum retries') as HTMLInputElement).value).toBe('3');
    expect((field(view, 'Filename template') as HTMLInputElement).value).toBe('{title}.{ext}');
    expect((field(view, 'Download subfolder') as HTMLInputElement).value).toBe('');
    expect((field(view, 'Show notifications') as HTMLInputElement).checked).toBe(true);
    expect((field(view, 'Keep history') as HTMLInputElement).checked).toBe(true);
    expect((field(view, 'Keep history for') as HTMLSelectElement).value).toBe('forever');
    expect((field(view, 'Detection sensitivity') as HTMLSelectElement).value).toBe('balanced');
    view.unmount();
  });

  it('persists a change through the approved contract', async () => {
    const fake = createFakeSettingsClient();
    const view = await mount(fake);

    selectOption(field(view, 'Theme') as HTMLSelectElement, 'dark');
    await flush();

    expect(fake.calls).toContain('updateSettings:theme');
    expect(fake.settings.theme).toBe('dark');
    expect((field(view, 'Theme') as HTMLSelectElement).value).toBe('dark');
    view.unmount();
  });

  it('confirms a save without interrupting the user', async () => {
    const fake = createFakeSettingsClient();
    const view = await mount(fake);
    expect(view.container.querySelector('.adl-settings__saved')).toBeNull();

    click(field(view, 'Keep history'));
    await flush();

    const saved = view.container.querySelector('.adl-settings__saved');
    expect(saved?.textContent).toBe('Saved');
    expect(saved?.getAttribute('aria-live')).toBe('polite');
    view.unmount();
  });

  it('toggles each boolean setting', async () => {
    const fake = createFakeSettingsClient();
    const view = await mount(fake);

    for (const [label, key] of [
      ['Show notifications', 'notifications'],
      ['Context menu entries', 'contextMenu'],
      ['Keep history', 'keepHistory'],
      ['Warn about duplicates', 'duplicateWarnings'],
    ] as const) {
      click(field(view, label));
      await flush();
      expect(fake.settings[key], label).toBe(false);
    }
    view.unmount();
  });

  it('reports a rejected value and keeps the stored catalogue intact', async () => {
    const fake = createFakeSettingsClient();
    const view = await mount(fake);
    const retries = field(view, 'Maximum retries') as HTMLInputElement;

    const { type } = await import('../_render');
    type(retries, '99');
    await flush();

    const notice = view.container.querySelector('.adl-notice');
    expect(notice?.getAttribute('role')).toBe('alert');
    expect(notice?.textContent).toContain('That value is not allowed');
    expect(notice?.textContent).not.toContain('settings-invalid-maxRetries');
    expect(fake.settings.maxRetries).toBe(DEFAULT_SETTINGS.maxRetries);

    click(requireByName(view.container, 'Dismiss'));
    expect(view.container.querySelector('.adl-notice')).toBeNull();
    view.unmount();
  });

  it('keeps the specific validation copy after the error crosses the message boundary', async () => {
    const fake = createFakeSettingsClient();
    const view = await mount(fake);
    // The bus normalizes a thrown error's category to `internal`; the stable code
    // is what identifies it as a rejected setting (§20.2).
    fake.failNext('updateSettings', {
      category: 'internal',
      code: 'settings-invalid-theme',
      messageKey: 'error.settings.invalid',
      retryable: false,
    });

    selectOption(field(view, 'Theme') as HTMLSelectElement, 'dark');
    await flush();

    expect(view.container.querySelector('.adl-notice')?.textContent).toContain(
      'That value is not allowed',
    );
    view.unmount();
  });

  it('restores every default from the reset control', async () => {
    const fake = createFakeSettingsClient();
    fake.settings = { ...DEFAULT_SETTINGS, theme: 'dark', maxRetries: 7 };
    const view = await mount(fake);

    click(
      requireByName(view.container, 'Reset all settings — Restores every setting to its default.'),
    );
    await flush();

    expect(fake.settings).toEqual(DEFAULT_SETTINGS);
    expect((field(view, 'Theme') as HTMLSelectElement).value).toBe('system');
    view.unmount();
  });

  it('shows the runtime-unavailable state and recovers on retry', async () => {
    const fake = createFakeSettingsClient();
    fake.failNext('getSettings', new Error('background is gone'));
    const view = await mount(fake);

    expect(view.container.querySelector('.adl-status--error')?.textContent).toContain(
      'AetherDL is not responding',
    );

    click(requireByName(view.container, 'Retry'));
    await flush();

    expect(view.container.querySelector('.adl-settings__main')).not.toBeNull();
    view.unmount();
  });

  it('follows a catalogue applied on another surface', async () => {
    const fake = createFakeSettingsClient();
    const view = await mount(fake);

    fake.emitSettings({ ...DEFAULT_SETTINGS, theme: 'dark' });
    await flush();

    expect((field(view, 'Theme') as HTMLSelectElement).value).toBe('dark');
    view.unmount();
  });

  it('edits every remaining setting through the form', async () => {
    const fake = createFakeSettingsClient();
    const view = await mount(fake);
    const { type } = await import('../_render');

    selectOption(field(view, 'Reduced motion') as HTMLSelectElement, 'on');
    await flush();
    selectOption(field(view, 'Language') as HTMLSelectElement, 'en');
    await flush();
    type(field(view, 'Maximum concurrent downloads') as HTMLInputElement, '5');
    await flush();
    type(field(view, 'Filename template') as HTMLInputElement, '{title}-{quality}.{ext}');
    await flush();
    type(field(view, 'Download subfolder') as HTMLInputElement, 'clips');
    await flush();
    selectOption(field(view, 'Detection sensitivity') as HTMLSelectElement, 'aggressive');
    await flush();
    selectOption(field(view, 'Keep history for') as HTMLSelectElement, '30d');
    await flush();

    expect(fake.settings).toMatchObject({
      reducedMotion: 'on',
      language: 'en',
      maxConcurrentDownloads: 5,
      filenameTemplate: '{title}-{quality}.{ext}',
      downloadSubfolder: 'clips',
      detectionSensitivity: 'aggressive',
      historyRetention: '30d',
    });
    view.unmount();
  });

  it('renders with no optional props at all', async () => {
    const fake = createFakeSettingsClient();
    const view = await renderAsync(<SettingsApp client={fake.client} />);
    expect(view.container.querySelector('.adl-settings__main')).not.toBeNull();
    view.unmount();
  });

  it('dismissing with nothing to dismiss changes nothing', async () => {
    const fake = createFakeSettingsClient();
    const view = await mount(fake);
    expect(byName(view.container, 'Dismiss')).toBeUndefined();
    // A no-op dismiss must not disturb the form (§8.7 ephemeral view state).
    fake.emitSettings({ ...DEFAULT_SETTINGS, theme: 'light' });
    await flush();
    expect(view.container.querySelector('.adl-notice')).toBeNull();
    view.unmount();
  });

  it('refuses to render a settings page that was not composed with a client', () => {
    expect(() => render(<Consumer />)).toThrow('SettingsClientProvider');
  });

  it('releases the settings subscription when the page closes', async () => {
    const fake = createFakeSettingsClient();
    const view = await mount(fake);
    expect(fake.subscriptions.count).toBe(1);
    view.unmount();
    expect(fake.subscriptions.count).toBe(0);
  });
});

describe('ui/settings SettingsApp — appearance applied to itself', () => {
  it('themes the page from the Theme setting', async () => {
    const fake = createFakeSettingsClient();
    fake.settings = { ...DEFAULT_SETTINGS, theme: 'dark' };
    const view = await mount(fake);
    expect(document.documentElement.dataset['theme']).toBe('dark');
    view.unmount();
  });

  it('follows the system preference when the theme is system', async () => {
    const view = await mount(createFakeSettingsClient(), ALWAYS_DARK);
    expect(document.documentElement.dataset['theme']).toBe('dark');
    view.unmount();
  });

  it('honours the reduced-motion setting over the system preference', async () => {
    const fake = createFakeSettingsClient();
    fake.settings = { ...DEFAULT_SETTINGS, reducedMotion: 'on' };
    const view = await mount(fake);
    expect(document.documentElement.dataset['reducedMotion']).toBe('true');
    view.unmount();
  });
});

describe('ui/settings SettingsApp — optional permissions', () => {
  it('shows both optional permissions as not granted, and never requests on load', async () => {
    const fake = createFakeSettingsClient();
    const view = await mount(fake);

    // Site access is listed in the same section, so it appears after the two
    // optional permissions.
    expect(texts(view.container, '.adl-permission__label')).toEqual([
      'Notifications',
      'Context menu',
      'Site access',
    ]);
    expect(texts(view.container, '.adl-permission__state')).toEqual([
      'Not granted',
      'Not granted',
      'No site access has been granted.',
    ]);
    expect(fake.calls.some((call) => call.startsWith('requestPermission'))).toBe(false);
    view.unmount();
  });

  it('requests a permission only when the user asks, then shows it granted', async () => {
    const fake = createFakeSettingsClient();
    const view = await mount(fake);

    click(requireByName(view.container, 'Grant: Notifications'));
    await flush();

    expect(fake.calls).toContain('requestPermission:notifications');
    expect(fake.granted.has('notifications')).toBe(true);
    expect(byName(view.container, 'Revoke: Notifications')).toBeDefined();
    view.unmount();
  });

  it('revokes a granted permission', async () => {
    const fake = createFakeSettingsClient();
    fake.granted.add('contextMenus');
    const view = await mount(fake);

    click(requireByName(view.container, 'Revoke: Context menu'));
    await flush();

    expect(fake.granted.has('contextMenus')).toBe(false);
    expect(byName(view.container, 'Grant: Context menu')).toBeDefined();
    view.unmount();
  });

  it('tells the user when the browser refuses the request', async () => {
    const fake = createFakeSettingsClient();
    fake.grantRequests = false;
    const view = await mount(fake);

    click(requireByName(view.container, 'Grant: Notifications'));
    await flush();

    expect(view.container.querySelector('.adl-notice')?.textContent).toContain(
      'The browser refused that permission request',
    );
    view.unmount();
  });

  it('surfaces a failed permission request', async () => {
    const fake = createFakeSettingsClient();
    const view = await mount(fake);
    fake.failNext('requestPermission', new Error('not allowed here'));

    click(requireByName(view.container, 'Grant: Notifications'));
    await flush();

    expect(view.container.querySelector('.adl-notice')).not.toBeNull();
    view.unmount();
  });
});

describe('ui/settings SettingsApp — history', () => {
  it('lists records and deletes one', async () => {
    const fake = createFakeSettingsClient();
    fake.history = [historyRecord({ id: 'a', title: 'Clip A' })];
    const view = await mount(fake);

    expect(texts(view.container, '.adl-history__item-title')).toEqual(['Clip A']);

    click(requireByName(view.container, 'Delete: Clip A'));
    await flush();

    expect(fake.calls).toContain('deleteHistory:a');
    expect(view.container.querySelector('.adl-history__item')).toBeNull();
    view.unmount();
  });

  it('erases everything from the clear control', async () => {
    const fake = createFakeSettingsClient();
    fake.history = [historyRecord({ id: 'a' }), historyRecord({ id: 'b' })];
    const view = await mount(fake);

    click(requireByName(view.container, 'Clear history — Erases every record from this device.'));
    await flush();

    expect(fake.calls).toContain('clearHistory');
    expect(fake.history).toEqual([]);
    view.unmount();
  });

  it('exports a local JSON file', async () => {
    const fake = createFakeSettingsClient();
    fake.history = [historyRecord({ id: 'a' })];
    const view = await mount(fake);

    click(requireByName(view.container, 'Export history — Saves a JSON file to your device.'));
    await flush();

    expect(fake.calls).toContain('exportHistory:aetherdl-history.json');
    view.unmount();
  });

  it('surfaces a failed export instead of failing silently', async () => {
    const fake = createFakeSettingsClient();
    fake.history = [historyRecord({ id: 'a' })];
    const view = await mount(fake);
    fake.failNext('exportHistory', new Error('disk full'));

    click(requireByName(view.container, 'Export history — Saves a JSON file to your device.'));
    await flush();

    expect(view.container.querySelector('.adl-notice')).not.toBeNull();
    view.unmount();
  });

  it('explains an empty history differently when recording is off', async () => {
    const fake = createFakeSettingsClient();
    fake.settings = { ...DEFAULT_SETTINGS, keepHistory: false };
    const view = await mount(fake);
    expect(view.container.querySelector('.adl-history__empty')?.textContent).toBe(
      'History is off, so nothing is being recorded.',
    );
    view.unmount();
  });
});

describe('ui/settings SettingsApp — accessibility and about', () => {
  it('labels every control and names every button', async () => {
    const fake = createFakeSettingsClient();
    fake.history = [historyRecord({ id: 'a' })];
    const view = await mount(fake);

    for (const control of view.container.querySelectorAll('input, select')) {
      const labelled =
        control.getAttribute('aria-label') !== null ||
        control.closest('label') !== null ||
        [...view.container.querySelectorAll('label')].some(
          (candidate) => candidate.htmlFor === control.id,
        );
      expect(labelled, `unlabelled: ${control.outerHTML.slice(0, 80)}`).toBe(true);
    }
    for (const button of view.container.querySelectorAll('button')) {
      const name = (button.getAttribute('aria-label') ?? button.textContent ?? '').trim();
      expect(name.length, `unnamed: ${button.outerHTML.slice(0, 80)}`).toBeGreaterThan(0);
    }
    view.unmount();
  });

  it('uses landmarks and labelled sections', async () => {
    const view = await mount(createFakeSettingsClient());
    expect(view.container.querySelector('header')).not.toBeNull();
    expect(view.container.querySelector('main')).not.toBeNull();
    for (const section of view.container.querySelectorAll('section')) {
      const id = section.getAttribute('aria-labelledby') ?? '';
      expect(id).not.toBe('');
      expect(byId(view.container, id)).toBeDefined();
    }
    view.unmount();
  });

  it('describes each field with its inline help', async () => {
    const view = await mount(createFakeSettingsClient());
    const theme = field(view, 'Theme');
    const describedBy = theme.getAttribute('aria-describedby') ?? '';
    expect(describedBy).not.toBe('');
    expect(byId(view.container, describedBy)?.textContent).toBe(
      'System follows your browser or operating system.',
    );
    view.unmount();
  });

  it('states the version, the shortcut and the privacy position', async () => {
    const view = await mount(createFakeSettingsClient());
    const about = texts(view.container, '.adl-settings__about').join(' ');
    expect(about).toContain('Version: 0.1.0');
    expect(about).toContain('Keyboard shortcut');
    expect(about).toContain('no telemetry');
    expect(view.container.querySelector('kbd')?.textContent).toBe('Ctrl+Shift+Y');
    view.unmount();
  });

  it('offers no control for sending data anywhere', async () => {
    const view = await mount(createFakeSettingsClient());
    const text = view.container.textContent ?? '';
    for (const forbidden of ['diagnostics', 'usage data', 'analytics', 'telemetry settings']) {
      expect(text.toLowerCase()).not.toContain(forbidden);
    }
    view.unmount();
  });
});

describe('ui/settings SettingsApp — site access (§4.15)', () => {
  it('lists every granted origin, so the user can see what was given away', async () => {
    const fake = createFakeSettingsClient();
    fake.siteAccess.add('https://cdn.test/*');
    fake.siteAccess.add('https://media.example/*');
    const view = await mount(fake);

    expect(texts(view.container, '.adl-sites__origin')).toEqual([
      'https://cdn.test/*',
      'https://media.example/*',
    ]);
    view.unmount();
  });

  it('withdraws one origin without touching the others', async () => {
    const fake = createFakeSettingsClient();
    fake.siteAccess.add('https://cdn.test/*');
    fake.siteAccess.add('https://media.example/*');
    const view = await mount(fake);

    click(requireByName(view.container, 'Revoke: https://cdn.test/*'));
    await flush();

    expect(fake.calls).toContain('revokeSiteAccess:https://cdn.test/*');
    expect([...fake.siteAccess]).toEqual(['https://media.example/*']);
    // Re-read from the browser rather than assumed: the list reflects what is granted.
    expect(texts(view.container, '.adl-sites__origin')).toEqual(['https://media.example/*']);
    view.unmount();
  });

  it('says plainly when nothing has been granted', async () => {
    const fake = createFakeSettingsClient();
    const view = await mount(fake);

    expect(view.container.textContent).toContain('No site access has been granted.');
    expect(byName(view.container, 'Revoke: https://cdn.test/*')).toBeUndefined();
    view.unmount();
  });

  it('still renders the page when the browser cannot report granted origins', async () => {
    // One unsupported call must not cost the user every other setting (§11.5, §7.2).
    const fake = createFakeSettingsClient();
    fake.failNext('listSiteAccess', new Error('permissions.getAll is unavailable'));
    const view = await mount(fake);

    // The rest of the page is intact: the form renders and is usable.
    expect(field(view, 'Warn about duplicates')).toBeDefined();
    expect(view.container.textContent).toContain('No site access has been granted.');
    view.unmount();
  });

  it('reports a failed revoke instead of pretending it worked', async () => {
    const fake = createFakeSettingsClient();
    fake.siteAccess.add('https://cdn.test/*');
    const view = await mount(fake);
    fake.failNext('revokeSiteAccess', new Error('browser said no'));

    click(requireByName(view.container, 'Revoke: https://cdn.test/*'));
    await flush();

    expect(view.container.querySelector('.adl-notice')).not.toBeNull();
    expect(texts(view.container, '.adl-sites__origin')).toEqual(['https://cdn.test/*']);
    view.unmount();
  });
});
