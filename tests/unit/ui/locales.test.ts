import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EN_MESSAGES, resolveCatalog, toCatalogName } from '@ui/popup';
import { resolveSettingsCatalog, SETTINGS_EN_MESSAGES, toSettingsCatalogName } from '@ui/settings';

interface CatalogEntry {
  readonly message: string;
  readonly description?: string;
}

const catalog = JSON.parse(
  readFileSync(resolve(process.cwd(), 'public/_locales/en/messages.json'), 'utf8'),
) as Record<string, CatalogEntry>;

/** Names the extension itself needs, outside any surface catalogue. */
const BACKGROUND_NAMES = [
  'extName',
  'extDescription',
  'commandOpenPopup',
  'contextMenuDownload',
  'notificationCompletedTitle',
  'notificationCompletedMessage',
  'notificationFailedTitle',
  'notificationFailedMessage',
  'notificationQueueTitle',
  'notificationQueueMessage',
];

describe('public/_locales/en catalogue', () => {
  it('uses only names the WebExtension i18n API accepts', () => {
    for (const name of Object.keys(catalog)) {
      expect(name, name).toMatch(/^[A-Za-z0-9_@]+$/);
    }
  });

  it('gives every message a non-empty string and a description', () => {
    for (const [name, entry] of Object.entries(catalog)) {
      expect(typeof entry.message, name).toBe('string');
      expect(entry.message.length, name).toBeGreaterThan(0);
      expect((entry.description ?? '').length, name).toBeGreaterThan(0);
    }
  });

  it('carries every name the extension itself uses', () => {
    for (const name of BACKGROUND_NAMES) {
      expect(catalog[name], name).toBeDefined();
    }
  });

  it('carries every popup key, with matching text', () => {
    for (const [key, message] of Object.entries(EN_MESSAGES)) {
      const name = toCatalogName(key as keyof typeof EN_MESSAGES);
      expect(catalog[name], `${key} → ${name}`).toBeDefined();
      expect(catalog[name]?.message, key).toBe(message);
    }
  });

  it('carries every settings key, with matching text', () => {
    for (const [key, message] of Object.entries(SETTINGS_EN_MESSAGES)) {
      const name = toSettingsCatalogName(key as keyof typeof SETTINGS_EN_MESSAGES);
      expect(catalog[name], `${key} → ${name}`).toBeDefined();
      expect(catalog[name]?.message, key).toBe(message);
    }
  });

  it('contains nothing the product does not use', () => {
    const used = new Set([
      ...BACKGROUND_NAMES,
      ...Object.keys(EN_MESSAGES).map((key) => toCatalogName(key as keyof typeof EN_MESSAGES)),
      ...Object.keys(SETTINGS_EN_MESSAGES).map((key) =>
        toSettingsCatalogName(key as keyof typeof SETTINGS_EN_MESSAGES),
      ),
    ]);
    expect([...Object.keys(catalog)].filter((name) => !used.has(name))).toEqual([]);
  });

  it('flattens dotted keys into catalogue names', () => {
    expect(toCatalogName('popup.count.other')).toBe('popup_count_other');
    expect(toSettingsCatalogName('settings.section.about')).toBe('settings_section_about');
  });

  it('resolves a catalogue through the lookup and falls back to English', () => {
    const resolved = resolveCatalog((name) =>
      name === 'popup_brand' ? 'AetherDL (translated)' : '',
    );
    expect(resolved['popup.brand']).toBe('AetherDL (translated)');
    expect(resolved['card.download']).toBe(EN_MESSAGES['card.download']);

    const settings = resolveSettingsCatalog(() => '');
    expect(settings['settings.title']).toBe(SETTINGS_EN_MESSAGES['settings.title']);
  });

  it('resolves the whole shipped catalogue back to the built-in text', () => {
    const lookup = (name: string): string => catalog[name]?.message ?? '';
    expect(resolveCatalog(lookup)).toEqual(EN_MESSAGES);
    expect(resolveSettingsCatalog(lookup)).toEqual(SETTINGS_EN_MESSAGES);
  });
});
