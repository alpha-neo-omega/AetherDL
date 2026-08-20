/**
 * Module: core/download/stream (HLS)
 * Purpose: Parse an HLS playlist (M3U8) into something assembly can act on
 *          (PROJECT_BIBLE.md §10.6, §5.5). Pure: it is handed text and returns a
 *          description. It never fetches, never writes, and never decides policy
 *          beyond refusing what must be refused.
 * Restrictions: Domain layer — no browser globals, no adapters. ENCRYPTION IS A HARD
 *          REFUSAL: any key method other than NONE ends parsing with a refusal, and a
 *          key URI is never read, returned or followed. No decryption exists in this
 *          codebase and none may be added (§6, ADR-005).
 * Dependencies: shared/utils (URL resolution).
 * Public API: HLS_MAX_TEXT_BYTES, HLS_MAX_SEGMENTS, HlsByteRange, HlsSegment,
 *          HlsVariant, HlsPlaylist, parseHlsPlaylist.
 */
import { parseUrl } from '@shared/utils';

/** A hostile playlist must not be able to exhaust memory (§10.9). */
export const HLS_MAX_TEXT_BYTES = 4 * 1024 * 1024;
export const HLS_MAX_SEGMENTS = 20_000;

export interface HlsByteRange {
  readonly offset: number;
  readonly length: number;
}

export interface HlsSegment {
  readonly url: string;
  readonly durationSec: number;
  readonly range?: HlsByteRange;
}

export interface HlsVariant {
  readonly url: string;
  readonly bandwidth?: number;
  readonly width?: number;
  readonly height?: number;
  readonly codecs?: string;
  /**
   * The `AUDIO` rendition group this variant expects, when it declares one. A
   * variant that names a group whose renditions carry their own `URI` carries no
   * audio itself: joining the two tracks is muxing, which this project does not do,
   * so such a stream is refused rather than saved as silent video.
   */
  readonly audioGroup?: string;
}

/**
 * What a playlist turned out to be. `refused` carries the reason in `reason` and is
 * the only outcome for encrypted content.
 */
/** An audio rendition that lives in its own playlist, and can therefore be muxed. */
export interface HlsAudioRendition {
  readonly group: string;
  readonly url: string;
  readonly name?: string;
  readonly isDefault: boolean;
}

export type HlsPlaylist =
  | {
      readonly kind: 'master';
      readonly variants: readonly HlsVariant[];
      /** `AUDIO` group ids whose renditions live in their own playlist. */
      readonly separateAudioGroups: readonly string[];
      /** Those renditions, resolved, so the caller can fetch and mux one. */
      readonly audioRenditions: readonly HlsAudioRendition[];
    }
  | {
      readonly kind: 'media';
      /** A live playlist has no `#EXT-X-ENDLIST`; assembly needs a finished one. */
      readonly live: boolean;
      readonly targetDurationSec?: number;
      readonly initSegment?: HlsSegment;
      readonly segments: readonly HlsSegment[];
    }
  | { readonly kind: 'refused'; readonly reason: string; readonly code: string };

const refused = (reason: string, code: string): HlsPlaylist => ({ kind: 'refused', reason, code });

/** Split `A=1,B="x,y"` respecting quotes. */
function splitAttributes(input: string): readonly string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of input) {
    if (char === '"') {
      quoted = !quoted;
      current += char;
    } else if (char === ',' && !quoted) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim() !== '') {
    parts.push(current);
  }
  return parts;
}

function parseAttributes(input: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const part of splitAttributes(input)) {
    const eq = part.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const name = part.slice(0, eq).trim().toUpperCase();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    out[name] = value;
  }
  return out;
}

function numeric(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Resolve a playlist URI against the manifest it came from. */
function resolve(uri: string, base: string): string | undefined {
  try {
    return new URL(uri, base).toString();
  } catch {
    return undefined;
  }
}

/**
 * `#EXT-X-BYTERANGE:<length>[@<offset>]`. With the offset omitted the segment
 * continues from the end of the previous one, so the caller must thread that along.
 */
function parseByteRange(value: string, previousEnd: number | undefined): HlsByteRange | undefined {
  const [rawLength, rawOffset] = value.split('@');
  const length = numeric(rawLength?.trim());
  if (length === undefined || length <= 0) {
    return undefined;
  }
  const offset = rawOffset === undefined ? previousEnd : numeric(rawOffset.trim());
  if (offset === undefined || offset < 0) {
    return undefined;
  }
  return { offset, length };
}

/** METHOD=NONE is the only acceptable key declaration. */
function encryptionRefusal(attributes: Readonly<Record<string, string>>): HlsPlaylist | undefined {
  const method = (attributes['METHOD'] ?? '').trim().toUpperCase();
  if (method === '' || method === 'NONE') {
    return undefined;
  }
  // Deliberately reports only the METHOD. The URI/KEYFORMAT attributes identify key
  // material and are never read, returned or logged.
  return refused(
    `Playlist is encrypted (METHOD=${method}); encrypted media is not downloadable`,
    'hls-encrypted',
  );
}

export function parseHlsPlaylist(text: string, manifestUrl: string): HlsPlaylist {
  if (parseUrl(manifestUrl) === undefined) {
    return refused('Manifest URL is not usable', 'hls-manifest-url-invalid');
  }
  if (text.length > HLS_MAX_TEXT_BYTES) {
    return refused('Playlist is larger than the accepted ceiling', 'hls-too-large');
  }

  const lines = text.split(/\r?\n/);
  // The tag must come first, but a file that opens with a blank line (or a BOM, which
  // `trim` removes) is still the playlist it says it is; only content before the tag
  // means this is not a playlist at all.
  const firstMeaningful = lines.findIndex((line) => line.trim() !== '');
  if (firstMeaningful === -1 || (lines[firstMeaningful] ?? '').trim() !== '#EXTM3U') {
    return refused('Not an HLS playlist (no #EXTM3U)', 'hls-not-a-playlist');
  }

  const variants: HlsVariant[] = [];
  // A group is only a SEPARATE audio track when every rendition in it has its own
  // URI. Apple's own advanced examples declare a group whose default rendition has no
  // URI — meaning the variants already carry that audio — alongside an alternate
  // rendition that does. Treating such a group as separate made assembly download a
  // video-only rendition and mux in the alternate track, which is not the stream the
  // page was playing. Found against real manifests (§16.9).
  const groupsWithUri = new Set<string>();
  const groupsWithoutUri = new Set<string>();
  const audioRenditions: HlsAudioRendition[] = [];
  const segments: HlsSegment[] = [];
  let live = true;
  let targetDurationSec: number | undefined;
  let initSegment: HlsSegment | undefined;
  let pendingDuration: number | undefined;
  let pendingRange: HlsByteRange | undefined;
  let pendingVariant: Omit<HlsVariant, 'url'> | undefined;
  let previousEnd: number | undefined;

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') {
      continue;
    }

    if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
      const refusal = encryptionRefusal(parseAttributes(line.slice(line.indexOf(':') + 1)));
      if (refusal !== undefined) {
        return refusal;
      }
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA:')) {
      // An AUDIO rendition with its own URI is a separate track; one without a URI is
      // muxed into the variants and needs no special handling.
      const attributes = parseAttributes(line.slice(line.indexOf(':') + 1));
      const type = (attributes['TYPE'] ?? '').trim().toUpperCase();
      const group = attributes['GROUP-ID'];
      if (type === 'AUDIO' && group !== undefined) {
        if (attributes['URI'] === undefined) {
          groupsWithoutUri.add(group);
        } else {
          groupsWithUri.add(group);
          const renditionUrl = resolve(attributes['URI'], manifestUrl);
          if (renditionUrl !== undefined) {
            audioRenditions.push({
              group,
              url: renditionUrl,
              ...(attributes['NAME'] !== undefined && { name: attributes['NAME'] }),
              isDefault: (attributes['DEFAULT'] ?? '').trim().toUpperCase() === 'YES',
            });
          }
        }
      }
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attributes = parseAttributes(line.slice(line.indexOf(':') + 1));
      const resolution = (attributes['RESOLUTION'] ?? '').split('x');
      pendingVariant = {
        ...(attributes['AUDIO'] !== undefined && { audioGroup: attributes['AUDIO'] }),
        ...(numeric(attributes['BANDWIDTH']) !== undefined && {
          bandwidth: numeric(attributes['BANDWIDTH']) as number,
        }),
        ...(numeric(resolution[0]) !== undefined && { width: numeric(resolution[0]) as number }),
        ...(numeric(resolution[1]) !== undefined && { height: numeric(resolution[1]) as number }),
        ...(attributes['CODECS'] !== undefined && { codecs: attributes['CODECS'] }),
      };
      continue;
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const attributes = parseAttributes(line.slice(line.indexOf(':') + 1));
      const uri = attributes['URI'];
      const url = uri === undefined ? undefined : resolve(uri, manifestUrl);
      if (url !== undefined) {
        const range =
          attributes['BYTERANGE'] === undefined
            ? undefined
            : parseByteRange(attributes['BYTERANGE'], undefined);
        initSegment = { url, durationSec: 0, ...(range !== undefined && { range }) };
      }
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      pendingDuration = numeric(line.slice(8).split(',')[0]?.trim()) ?? 0;
      continue;
    }

    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = parseByteRange(line.slice(17).trim(), previousEnd);
      continue;
    }

    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDurationSec = numeric(line.slice(22).trim());
      continue;
    }

    if (line === '#EXT-X-ENDLIST') {
      live = false;
      continue;
    }

    if (line.startsWith('#')) {
      // Unknown or informational tag: ignored by design, per the spec's rule that
      // clients skip tags they do not recognise.
      continue;
    }

    // A bare line is a URI: a variant when a STREAM-INF preceded it, else a segment.
    const url = resolve(line, manifestUrl);
    if (url === undefined) {
      return refused(`Playlist URI cannot be resolved: ${line}`, 'hls-uri-unresolvable');
    }

    if (pendingVariant !== undefined) {
      variants.push({ url, ...pendingVariant });
      pendingVariant = undefined;
      continue;
    }

    if (segments.length >= HLS_MAX_SEGMENTS) {
      return refused('Playlist declares more segments than the accepted ceiling', 'hls-too-many');
    }
    segments.push({
      url,
      durationSec: pendingDuration ?? 0,
      ...(pendingRange !== undefined && { range: pendingRange }),
    });
    previousEnd =
      pendingRange !== undefined ? pendingRange.offset + pendingRange.length : previousEnd;
    pendingDuration = undefined;
    pendingRange = undefined;
  }

  if (variants.length > 0) {
    const separateAudioGroups = [...groupsWithUri].filter((group) => !groupsWithoutUri.has(group));
    return {
      kind: 'master',
      variants,
      separateAudioGroups,
      audioRenditions,
    };
  }
  if (segments.length === 0) {
    return refused('Playlist lists no segments', 'hls-empty');
  }
  return {
    kind: 'media',
    live,
    segments,
    ...(targetDurationSec !== undefined && { targetDurationSec }),
    ...(initSegment !== undefined && { initSegment }),
  };
}
