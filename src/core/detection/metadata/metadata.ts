/**
 * Module: core/detection/metadata (implementation)
 * Purpose: Best-effort, URL-derived metadata (PROJECT_BIBLE.md §4.2, §9.6). Fills
 *          only what can be derived deterministically; never fabricates values.
 * Restrictions: Domain layer — pure.
 * Public API: createMetadataExtractor.
 */
import type { MediaItem } from '@shared/types';
import { extensionToMime, filenameFromUrl, getExtension } from '@shared/utils';
import type { MetadataExtractor } from '@core/detection/metadata';

export function createMetadataExtractor(): MetadataExtractor {
  return {
    extract(source: Pick<MediaItem, 'url' | 'kind'>): Promise<Partial<MediaItem>> {
      const ext = getExtension(source.url);
      const mimeType = ext !== undefined ? extensionToMime(ext) : undefined;
      const filename = filenameFromUrl(source.url);
      const result: Partial<MediaItem> = {
        ...(ext !== undefined && { container: ext, extension: ext }),
        ...(mimeType !== undefined && { mimeType }),
        ...(filename !== undefined && { filename }),
      };
      return Promise.resolve(result);
    },
  };
}
