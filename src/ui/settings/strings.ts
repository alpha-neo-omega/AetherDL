/**
 * Module: ui/settings (message catalog)
 * Purpose: Every user-facing string of the settings page and the history view,
 *          addressed by message key (PROJECT_BIBLE.md §19.1). Components receive
 *          resolved text, so swapping in a locale catalogue never touches a
 *          component.
 * Restrictions: UI layer — data only. Keys mirror the catalogue naming under
 *          `public/_locales/<locale>/messages.json`; English is the default and the
 *          fallback locale (§19.2).
 * Public API: SETTINGS_EN_MESSAGES, SettingsMessageKey, TranslateSettings,
 *          createSettingsTranslator, toSettingsCatalogName, resolveSettingsCatalog.
 */
import { createMessageResolver, type MessageResolver } from '@shared/utils';

/** The English catalogue. Its keys define {@link SettingsMessageKey}. */
export const SETTINGS_EN_MESSAGES = {
  'settings.title': 'AetherDL Settings',
  'settings.loading': 'Loading settings',
  'settings.saved': 'Saved',
  'settings.reset': 'Reset all settings',
  'settings.resetHint': 'Restores every setting to its default.',
  'settings.dismiss': 'Dismiss',

  'settings.section.appearance': 'Appearance',
  'settings.section.downloads': 'Downloads',
  'settings.section.detection': 'Detection',
  'settings.section.streams': 'Streams',
  'settings.section.notifications': 'Notifications',
  'settings.section.history': 'History',
  'settings.section.permissions': 'Permissions',
  'settings.section.about': 'About',

  'settings.theme': 'Theme',
  'settings.theme.help': 'System follows your browser or operating system.',
  'settings.theme.system': 'System',
  'settings.theme.light': 'Light',
  'settings.theme.dark': 'Dark',

  'settings.reducedMotion': 'Reduced motion',
  'settings.reducedMotion.help': 'Turns off non-essential animation.',
  'settings.reducedMotion.system': 'System',
  'settings.reducedMotion.on': 'On',
  'settings.reducedMotion.off': 'Off',

  'settings.language': 'Language',
  'settings.language.help': 'System uses your browser language.',
  'settings.language.system': 'System',
  'settings.language.en': 'English',

  'settings.maxConcurrentDownloads': 'Maximum concurrent downloads',
  'settings.maxConcurrentDownloads.help': 'Between 1 and 10. Applies to new downloads.',
  'settings.maxRetries': 'Maximum retries',
  'settings.maxRetries.help': 'Between 0 and 10. Only transient failures are retried.',
  'settings.filenameTemplate': 'Filename template',
  'settings.filenameTemplate.help': 'Tokens: {title}, {host}, {ext}, {quality}, {date}, {index}.',
  'settings.downloadSubfolder': 'Download subfolder',
  'settings.downloadSubfolder.help': 'Relative to your Downloads folder. Leave empty for none.',
  'settings.duplicateWarnings': 'Warn about duplicates',
  'settings.duplicateWarnings.help': 'Flags media that already appears in your history.',

  'settings.streamQuality': 'Stream quality',
  'settings.streamQuality.help':
    'Which rendition to take when a stream offers several. A height is a ceiling: the best copy at or below it.',
  'settings.streamQuality.highest': 'Highest available',
  'settings.streamQuality.2160': 'Up to 2160p (4K)',
  'settings.streamQuality.1440': 'Up to 1440p',
  'settings.streamQuality.1080': 'Up to 1080p',
  'settings.streamQuality.720': 'Up to 720p',
  'settings.streamQuality.480': 'Up to 480p',
  'settings.streamQuality.lowest': 'Smallest available',
  'settings.detectionSensitivity': 'Detection sensitivity',
  'settings.detectionSensitivity.help': 'How eagerly AetherDL treats a candidate as media.',
  'settings.detectionSensitivity.conservative': 'Conservative',
  'settings.detectionSensitivity.balanced': 'Balanced',
  'settings.detectionSensitivity.aggressive': 'Aggressive',

  'settings.notifications': 'Show notifications',
  'settings.notifications.help': 'Tells you when a download finishes or fails.',
  'settings.contextMenu': 'Context menu entries',
  'settings.contextMenu.help': 'Adds "Download with AetherDL" when you right-click media.',

  'settings.keepHistory': 'Keep history',
  'settings.keepHistory.help': 'History stays on this device and is never sent anywhere.',
  'settings.historyRetention': 'Keep history for',
  'settings.historyRetention.forever': 'Forever',
  'settings.historyRetention.30d': '30 days',
  'settings.historyRetention.90d': '90 days',
  'settings.historyRetention.session': 'This session',

  'permissions.granted': 'Granted',
  'permissions.notGranted': 'Not granted',
  'permissions.grant': 'Grant',
  'permissions.revoke': 'Revoke',
  'permissions.notifications': 'Notifications',
  'permissions.notifications.help': 'Needed to show download notifications.',
  'permissions.contextMenus': 'Context menu',
  'permissions.contextMenus.help': 'Needed to add entries to the right-click menu.',
  'permissions.denied': 'The browser did not grant that permission.',
  'permissions.sites': 'Site access',
  'permissions.sites.help':
    'Sites AetherDL may read a stream from. Each one was granted when you started a download; revoking one only stops stream downloads from that site.',
  'permissions.sites.none': 'No site access has been granted.',

  'about.version': 'Version',
  'about.shortcut': 'Keyboard shortcut',
  'about.shortcutHint': 'Opens the AetherDL popup. Rebind it in your browser settings.',
  'about.privacy':
    'AetherDL has no account, no telemetry and sends nothing anywhere. It reads a playlist and its segments only to download what you asked for, on hosts you granted.',

  'history.title': 'Download history',
  'history.searchLabel': 'Search history',
  'history.searchPlaceholder': 'Search',
  'history.outcomeLabel': 'Outcome',
  'history.outcome.all': 'All',
  'history.outcome.completed': 'Completed',
  'history.outcome.failed': 'Failed',
  'history.sortLabel': 'Sort',
  'history.sort.newest': 'Newest',
  'history.sort.oldest': 'Oldest',
  'history.sort.title': 'Title',
  'history.sort.size': 'Size',
  'history.count.one': '1 record',
  'history.count.other': '{count} records',
  'history.empty': 'Nothing downloaded yet.',
  'history.noMatches': 'No records match your search.',
  'history.disabled': 'History is off, so nothing is being recorded.',
  'history.delete': 'Delete',
  'history.clear': 'Clear history',
  'history.clearHint': 'Erases every record from this device.',
  'history.export': 'Export history',
  'history.exportHint': 'Saves a JSON file to your device.',
  'history.exportFilename': 'aetherdl-history.json',
  'history.list.label': 'History records',
  'history.field.outcome': 'Outcome',
  'history.field.size': 'Size',
  'history.field.host': 'Host',
  'history.field.when': 'Downloaded',
  'history.field.filename': 'Filename',

  'settings.error.title': 'Something went wrong',
  'settings.error.invalid': 'That value is not allowed. Nothing was saved.',
  'settings.error.storage': 'Could not save to this device. Try again.',
  'settings.error.permission': 'The browser refused that permission request.',
  'settings.error.capability': 'Not supported in this browser.',
  'settings.error.internal': 'Something went wrong. Try again.',
  'settings.error.unavailable.title': 'AetherDL is not responding',
  'settings.error.unavailable.detail': 'The background service did not answer. Try again.',
  'settings.error.retry': 'Retry',
} as const;

export type SettingsMessageKey = keyof typeof SETTINGS_EN_MESSAGES;

export type TranslateSettings = MessageResolver<SettingsMessageKey>;

/** Build a translator over a catalogue, falling back to English (§19.2). */
export function createSettingsTranslator(
  catalog: Readonly<Record<SettingsMessageKey, string>> = SETTINGS_EN_MESSAGES,
): TranslateSettings {
  return createMessageResolver<SettingsMessageKey>(catalog, SETTINGS_EN_MESSAGES);
}

/**
 * The WebExtension catalogue name for a message key. Catalogue names allow only
 * `[A-Za-z0-9_@]`, so the dotted key is flattened (§19.1).
 */
export function toSettingsCatalogName(key: SettingsMessageKey): string {
  return key.replace(/\./g, '_');
}

/**
 * Build a catalogue by resolving every key through `lookup` — normally the
 * platform i18n service. A name the active locale does not translate falls back to
 * the built-in English text, so a partial catalogue never renders blanks (§19.2).
 */
export function resolveSettingsCatalog(
  lookup: (name: string) => string,
): Readonly<Record<SettingsMessageKey, string>> {
  const resolved: Record<string, string> = {};
  for (const key of Object.keys(SETTINGS_EN_MESSAGES) as SettingsMessageKey[]) {
    const translated = lookup(toSettingsCatalogName(key));
    resolved[key] = translated === '' ? SETTINGS_EN_MESSAGES[key] : translated;
  }
  return resolved as Record<SettingsMessageKey, string>;
}
