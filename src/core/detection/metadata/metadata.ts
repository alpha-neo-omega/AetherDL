/**
 * Module: core/detection/metadata (implementation)
 * Purpose: Best-effort, URL-derived metadata (PROJECT_BIBLE.md §4.2, §9.6). Fills
 *          only what can be derived deterministically; never fabricates values.
 * Restrictions: Domain layer — pure.
 * Public API: createMetadataExtractor.
 */
import type { MediaItem } from '@shared/types';
import {
  extensionToMime,
  filenameFromUrl,
  getExtension,
  isSupportedExtension,
} from '@shared/utils';
import type { MetadataExtractor } from '@core/detection/metadata';

export function createMetadataExtractor(): MetadataExtractor {
  return {
    extract(source: Pick<MediaItem, 'url' | 'kind'>): Promise<Partial<MediaItem>> {
      const ext = getExtension(source.url);
      // Only a KNOWN media extension is a container. A URL ending `.txt` or `.css`
      // says nothing about what the bytes are — and hosts do serve playlists and
      // MPEG-TS segments under exactly those names — so reporting it as the container
      // would be fabricating a value, which this module does not do (§4.2, §9.6).
      const container = ext !== undefined && isSupportedExtension(ext) ? ext : undefined;
      const mimeType = ext !== undefined ? extensionToMime(ext) : undefined;
      const filename = filenameFromUrl(source.url);
      const result: Partial<MediaItem> = {
        ...(container !== undefined && { container, extension: container }),
        ...(mimeType !== undefined && { mimeType }),
        ...(filename !== undefined && { filename }),
      };
      return Promise.resolve(result);
    },
  };
}
