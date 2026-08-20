/**
 * Module: ui/popup (message catalog)
 * Purpose: Every user-facing popup string, addressed by message key
 *          (PROJECT_BIBLE.md §19.1: no hard-coded strings in components — each has a
 *          key). Components receive resolved text as props; only this table holds
 *          copy, so the WebExtension catalog wired in a later phase replaces the
 *          resolver without touching a single component.
 * Restrictions: UI layer — data only. Keys mirror the catalog naming used under
 *          `public/_locales/<locale>/messages.json`. English is the default and
 *          fallback locale (§19.2).
 * Public API: MessageKey, Translate, EN_MESSAGES, createTranslator, toCatalogName,
 *          resolveCatalog.
 */
import { createMessageResolver } from '@shared/utils';

/** The English catalog. Its keys define the {@link MessageKey} union. */
export const EN_MESSAGES = {
  'popup.brand': 'AetherDL',
  'popup.searchLabel': 'Search media',
  'popup.searchPlaceholder': 'Search',
  'popup.kindLabel': 'Kind',
  'popup.kind.all': 'All',
  'popup.kind.video': 'Video',
  'popup.kind.audio': 'Audio',
  'popup.kind.stream': 'Stream',
  'popup.kind.imageSequence': 'Image sequence',
  'popup.sortLabel': 'Sort',
  'popup.sort.score': 'Best match',
  'popup.sort.title': 'Title',
  'popup.sort.sizeBytes': 'Size',
  'popup.sort.durationSec': 'Duration',
  'popup.sort.discoveredAt': 'Newest',
  'popup.count.one': '1 item',
  'popup.count.other': '{count} items',
  'popup.results.label': 'Detected media',
  'popup.selectAll': 'Select all',
  'popup.clearSelection': 'Clear selection',
  'popup.downloadSelected': 'Download selected',

  'popup.loading.title': 'Looking for media',
  'popup.loading.detail': 'Reading what this tab has detected.',
  'popup.empty.title': 'No media detected',
  'popup.empty.detail': 'Play or open media on this page, then reopen AetherDL.',
  'popup.noMatches.title': 'No matches',
  'popup.noMatches.detail': 'No detected media matches your search or filter.',
  'popup.retry': 'Retry',

  'card.download': 'Download',
  'card.copyLink': 'Copy link',
  'card.chooseQuality': 'Quality',
  'quality.title': 'Choose a quality',
  'quality.loading': 'Reading the stream…',
  'quality.empty': 'This stream offers only one quality.',
  'quality.cancel': 'Cancel',
  'quality.preferred': 'Preferred',
  'quality.audioTrack': 'Audio track',
  'card.select': 'Select',
  'card.unsupported': 'Unsupported',
  'card.estimated': 'estimated',
  'card.alreadyQueued': 'Already in the download queue.',
  'card.progress': 'Download progress',
  'card.field.type': 'Type',
  'card.field.quality': 'Quality',
  'card.field.resolution': 'Resolution',
  'card.field.duration': 'Duration',
  'card.field.size': 'Size',
  'card.field.host': 'Host',
  'card.field.filename': 'Filename',
  'card.field.codec': 'Codec',
  'card.field.delivery': 'Delivery',
  'card.delivery.progressive': 'Progressive file',
  'card.delivery.direct': 'Direct file',
  'card.delivery.html5': 'HTML5 media',
  'card.delivery.hls': 'HLS stream',
  'card.delivery.dash': 'DASH stream',
  'card.delivery.blob': 'In-page blob',
  'card.delivery.mediaSource': 'MediaSource stream',

  'queue.title': 'Queue',
  'queue.show': 'Show queue',
  'queue.hide': 'Hide queue',
  'queue.empty': 'Nothing queued.',
  'queue.summary': '{active} active · {queued} queued',
  'queue.clear': 'Clear',
  'queue.clearHint': 'Removes every job except transfers in progress.',
  'queue.cancel': 'Cancel',
  'queue.retry': 'Retry',
  'queue.pause': 'Pause',
  'queue.resume': 'Resume',
  'queue.remove': 'Remove',
  'queue.list.label': 'Download queue',

  'task.queued': 'Queued',
  'task.preparing': 'Preparing',
  'task.active': 'Downloading',
  'task.paused': 'Paused',
  'task.retrying': 'Retrying',
  'task.canceling': 'Cancelling',
  'task.canceled': 'Cancelled',
  'task.completed': 'Completed',
  'task.failed': 'Failed',
  'task.removed': 'Removed',

  'error.title': 'Something went wrong',
  'error.network': 'Connection problem. Check your network and try again.',
  'error.http': 'The server refused the download.',
  'error.drm': 'This media is protected and cannot be downloaded.',
  'error.validation': 'That media link cannot be downloaded.',
  'error.storage': 'Could not save the download queue. Try again.',
  'error.permission': 'AetherDL needs the downloads permission to save files.',
  'error.permission.host':
    'AetherDL needs access to the media host to download a stream. Nothing is downloaded without it.',
  'error.download.stream': 'This stream could not be assembled into a file.',
  'error.download.stream.live':
    'This is a live stream. A live stream has no end, so there is nothing to save.',
  'error.download.stream.tooLarge':
    'This stream is too large to assemble in one piece on this device.',
  'error.download.stream.tracks':
    'This stream keeps its audio and video in separate tracks. AetherDL will not save it as a file with no sound.',
  'error.capability': 'Not supported in this browser.',
  'error.internal': 'Something went wrong. Try again.',
  'error.unavailable.title': 'AetherDL is not responding',
  'error.unavailable.detail': 'The background service did not answer. Try again.',
  'error.dismiss': 'Dismiss',
} as const;

export type MessageKey = keyof typeof EN_MESSAGES;

/** Resolve a message key, substituting `{name}` placeholders. */
export type Translate = (key: MessageKey, values?: Readonly<Record<string, string>>) => string;

/**
 * Build a translator over a catalog. The default catalog is English, which is also
 * the fallback for any key a future locale has not translated (§19.2).
 */
export function createTranslator(
  catalog: Readonly<Record<MessageKey, string>> = EN_MESSAGES,
): Translate {
  return createMessageResolver<MessageKey>(catalog, EN_MESSAGES);
}

/**
 * The WebExtension catalogue name for a message key. Catalogue names allow only
 * `[A-Za-z0-9_@]`, so the dotted key is flattened (§19.1).
 */
export function toCatalogName(key: MessageKey): string {
  return key.replace(/\./g, '_');
}

/**
 * Build a catalogue by resolving every key through `lookup` — normally the
 * platform i18n service. A name the active locale does not translate falls back to
 * the built-in English text, so a partial catalogue never renders blanks (§19.2).
 */
export function resolveCatalog(
  lookup: (name: string) => string,
): Readonly<Record<MessageKey, string>> {
  const resolved: Record<string, string> = {};
  for (const key of Object.keys(EN_MESSAGES) as MessageKey[]) {
    const translated = lookup(toCatalogName(key));
    resolved[key] = translated === '' ? EN_MESSAGES[key] : translated;
  }
  return resolved as Record<MessageKey, string>;
}
