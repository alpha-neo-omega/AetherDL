/**
 * Module: core/download/filename
 * Purpose: Deterministic filename-generation contract (PROJECT_BIBLE.md §10.7).
 *          Collision handling is delegated to the browser conflict action (§10.7).
 * Restrictions: Domain layer — pure; output sanitized to OS-safe form.
 * Dependencies: shared/types.
 * Public API: FilenameGenerator.
 */
import type { MediaItem } from '@shared/types';

export interface FilenameGenerator {
  /**
   * Generate a safe filename from a template (§10.7). Tokens: `{title}`, `{host}`,
   * `{ext}`, `{quality}`, `{date}`, `{index}`. The optional `index` (additive) fills
   * `{index}` for batch numbering. Output is sanitized and preserves the extension.
   */
  generate(item: MediaItem, template: string, index?: number): string;
}
