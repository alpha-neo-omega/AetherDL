/**
 * Module: core/download/filename (implementation)
 * Purpose: Deterministic filename generation, normalization, and collision
 *          resolution (PROJECT_BIBLE.md §10.7). Illegal characters removed;
 *          extension preserved where possible. Disk collisions are additionally
 *          delegated to the browser conflict action (`uniquify`).
 * Restrictions: Domain layer — pure; clock injected for the `{date}` token.
 * Public API: sanitizeFilename, resolveCollision, createFilenameGenerator.
 */
import type { MediaItem } from '@shared/types';
import { getExtension } from '@shared/utils';
import type { FilenameGenerator } from '@core/download/filename';

/** OS-reserved characters. Spaces and hyphens are legal and preserved. */
const ILLEGAL_CHARS: ReadonlySet<string> = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);
const MAX_BASENAME_LENGTH = 200;
/** Cap the extension segment: real extensions are short; untrusted input is not. */
const MAX_EXT_LENGTH = 24;
/** Total filename cap — must stay under the common OS NAME_MAX (255 bytes). */
const MAX_TOTAL_LENGTH = 255;
/** Stand-in when a name sanitizes to nothing. */
const FALLBACK_BASENAME = 'download';

/** Replace filesystem-illegal and control characters with `_`. */
function stripIllegal(name: string): string {
  let out = '';
  for (const ch of name) {
    out += ILLEGAL_CHARS.has(ch) || ch.charCodeAt(0) < 0x20 ? '_' : ch;
  }
  return out;
}

/** UTF-8 byte length — NAME_MAX is a byte limit, not a code-unit limit. */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Trim trailing code points until the UTF-8 byte length fits `maxBytes`. */
function clampToBytes(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) {
    return text;
  }
  const chars = [...text];
  while (chars.length > 0 && utf8Bytes(chars.join('')) > maxBytes) {
    chars.pop();
  }
  return chars.join('');
}

/** Normalize a name: strip illegal/control chars, collapse whitespace, cap length. */
export function sanitizeFilename(name: string): string {
  // Collapse whitespace, then strip any trailing run of dots/spaces (Windows rejects
  // trailing dots), then trim leading. Order matters: a "name. " must lose its dot.
  const cleaned = stripIllegal(name)
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '')
    .trim();
  const safe = cleaned === '' ? FALLBACK_BASENAME : cleaned;
  const dot = safe.lastIndexOf('.');
  if (dot > 0 && dot < safe.length - 1) {
    // Bound BOTH segments in BYTES (untrusted title/container/extension): a
    // multibyte or oversized name must not push the total past NAME_MAX, or the
    // native layer rejects the download (§10.7).
    const ext = clampToBytes(safe.slice(dot + 1).slice(0, MAX_EXT_LENGTH), MAX_EXT_LENGTH);
    const base = clampToBytes(
      safe.slice(0, dot).slice(0, MAX_BASENAME_LENGTH),
      MAX_TOTAL_LENGTH - utf8Bytes(`.${ext}`),
    );
    return `${base === '' ? FALLBACK_BASENAME : base}.${ext}`;
  }
  return clampToBytes(safe, MAX_TOTAL_LENGTH);
}

/** The extension exactly as {@link sanitizeFilename} would preserve it. */
function normalizedExtension(ext: string): string {
  return clampToBytes(stripIllegal(ext).slice(0, MAX_EXT_LENGTH), MAX_EXT_LENGTH).toLowerCase();
}

/**
 * The name's OWN extension (last dot-delimited segment), lowercased; '' if none.
 * Dot-based on purpose — a URL-oriented parser would split on '#'/'?', which are
 * legal in filenames, and miss the real extension (causing a doubled append).
 */
function ownExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Resolve a collision against existing names by inserting ` (n)` before the ext. */
export function resolveCollision(name: string, existing: ReadonlySet<string>): string {
  if (!existing.has(name)) {
    return name;
  }
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0 && dot < name.length - 1;
  const base = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';
  // Re-clamp the base so the ` (n)` disambiguator cannot push an already
  // max-length name past NAME_MAX (§10.7) — the native layer would reject it.
  const build = (n: number): string => {
    const suffix = ` (${n})`;
    const boundedBase = clampToBytes(base, MAX_TOTAL_LENGTH - utf8Bytes(`${suffix}${ext}`));
    return `${boundedBase}${suffix}${ext}`;
  };
  for (let n = 1; n < 10_000; n += 1) {
    const candidate = build(n);
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
  return build(existing.size);
}

function isoDate(clock: () => number): string {
  return new Date(clock()).toISOString().slice(0, 10);
}

function resolveExtension(item: MediaItem): string {
  return item.extension ?? item.container ?? getExtension(item.url) ?? '';
}

/**
 * The `{title}` token without a trailing copy of the file's own extension.
 *
 * A title is frequently derived from the media's filename (`sample.mp4`, §9.3), so
 * the default template `{title}.{ext}` would render `sample.mp4.mp4`. Only an
 * extension that MATCHES the resolved one is dropped: a title ending in a different
 * extension keeps it, because that text is part of the name the user sees and the
 * correct extension is still appended after it (§10.7 "preserves the correct
 * extension"). A title that is nothing but the extension leaves no base at all, so
 * it falls back to the same stand-in the sanitizer uses for an empty name.
 */
function titleToken(title: string, ext: string): string {
  if (ext === '') {
    return title;
  }
  // Compare against the trimmed title: the sanitizer collapses surrounding
  // whitespace anyway, so `"sample.mp4 "` must be recognised as already carrying the
  // extension rather than becoming `sample.mp4 .mp4`.
  const trimmed = title.trim();
  const suffix = `.${normalizedExtension(ext)}`;
  if (!trimmed.toLowerCase().endsWith(suffix)) {
    return title;
  }
  // Drop every trailing copy: a title that already reads `sample.mp4.mp4` must not
  // keep one of them and gain another from the template.
  let stripped = trimmed;
  while (stripped.toLowerCase().endsWith(suffix)) {
    stripped = stripped.slice(0, stripped.length - suffix.length);
  }
  return stripped.trim() === '' ? FALLBACK_BASENAME : stripped;
}

export function createFilenameGenerator(clock: () => number = () => Date.now()): FilenameGenerator {
  return {
    generate(item: MediaItem, template: string, index?: number): string {
      const ext = resolveExtension(item);
      const tokens: Readonly<Record<string, string>> = {
        title: titleToken(item.title, ext),
        host: item.originHost,
        ext,
        quality: item.quality ?? '',
        date: isoDate(clock),
        index: index !== undefined ? String(index) : '',
      };
      // Single-pass FUNCTION replacer: untrusted token values are inserted
      // literally, so `$`-sequences in the title cannot be read as replacement
      // patterns and an earlier value cannot re-inject a later token literal.
      const replaced = template.replace(
        /\{(title|host|ext|quality|date|index)\}/g,
        (_match, key: string) => tokens[key] ?? '',
      );
      let name = sanitizeFilename(replaced);
      // Preserve the extension: append it only if the sanitized name does not
      // already end with it. Compare against the NORMALIZED (truncated) ext, else a
      // long/oversized extension would never match and would be doubled.
      if (ext !== '' && ownExtension(name) !== normalizedExtension(ext)) {
        name = sanitizeFilename(`${name}.${ext}`);
      }
      return name;
    },
  };
}
