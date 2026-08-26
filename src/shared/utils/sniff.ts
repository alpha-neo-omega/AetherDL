/**
 * Module: shared/utils (content sniffing)
 * Purpose: Say what a resource IS from its first bytes, rather than from what its URL
 *          or its `Content-Type` claims (PROJECT_BIBLE.md §5.1, §9.1).
 *
 *          This exists because names lie. A real video host serves its HLS playlist
 *          with a `.txt` extension as `text/plain`, and its MPEG-TS segments with a
 *          `.css` extension as `text/css`, specifically so that extension-matching
 *          tools see stylesheets instead of video. Every gate in this codebase that
 *          asked "what does the URL end in?" answered wrong for that site, and would
 *          answer wrong for the next one. Bytes cannot be renamed.
 *
 * Restrictions: Leaf layer — pure, no I/O, no browser globals (§8.16). It reads a
 *          prefix and returns a label; it never fetches, decodes, or transforms. It
 *          recognises containers only: an encrypted stream is still refused by the
 *          parsers, and nothing here can decrypt anything (§6, ADR-005).
 * Dependencies: none.
 * Public API: SNIFF_PREFIX_BYTES, SniffedFormat, HlsPlaylistRole, sniffFormat,
 *          sniffHlsRole, isStreamManifestFormat, containerOfFormat.
 */

/**
 * Bytes needed to identify anything here.
 *
 * The largest single check needs 377 bytes (three transport-stream sync bytes, 188
 * apart); a kilobyte leaves room for leading whitespace, a byte-order mark, or an XML
 * declaration before a DASH manifest's root element.
 */
export const SNIFF_PREFIX_BYTES = 1024;

/** What a prefix turned out to be, or `undefined` when nothing matched. */
export type SniffedFormat = 'hls' | 'dash' | 'mpeg-ts' | 'mp4' | 'webm' | 'adts';

/** A master playlist lists renditions; a media playlist lists segments. */
export type HlsPlaylistRole = 'master' | 'media';

/** One transport-stream packet; the sync byte repeats at this interval. */
const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;

/** ISO-BMFF box types that can legitimately open a file or a media segment. */
const MP4_LEADING_BOXES: ReadonlySet<string> = new Set([
  'ftyp',
  'styp',
  'moof',
  'moov',
  'sidx',
  'free',
  'skip',
]);

function ascii(bytes: Uint8Array, from: number, length: number): string {
  let out = '';
  for (let index = from; index < from + length && index < bytes.byteLength; index += 1) {
    out += String.fromCharCode(bytes[index] ?? 0);
  }
  return out;
}

/**
 * Where the meaningful text starts: past a UTF-8 byte-order mark and any leading
 * whitespace. A playlist that opens with a BOM is still a playlist.
 */
function textStart(bytes: Uint8Array): number {
  let at = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    at = 3;
  }
  while (at < bytes.byteLength) {
    const byte = bytes[at] ?? 0;
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      break;
    }
    at += 1;
  }
  return at;
}

/**
 * MPEG-TS, confirmed by repetition.
 *
 * A single 0x47 is one byte in 256 and would misfire constantly; a stream that puts
 * one at 0, 188 and 376 is a transport stream. Two sync bytes are accepted when the
 * prefix is too short for three, because a caller may hold only a partial packet.
 */
function isTransportStream(bytes: Uint8Array): boolean {
  if (bytes[0] !== TS_SYNC_BYTE) {
    return false;
  }
  if (bytes.byteLength > TS_PACKET_SIZE * 2) {
    return bytes[TS_PACKET_SIZE] === TS_SYNC_BYTE && bytes[TS_PACKET_SIZE * 2] === TS_SYNC_BYTE;
  }
  if (bytes.byteLength > TS_PACKET_SIZE) {
    return bytes[TS_PACKET_SIZE] === TS_SYNC_BYTE;
  }
  return false;
}

/** ISO-BMFF: a plausible box size, then a box type that may open a file. */
function isIsoBmff(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 8) {
    return false;
  }
  const size =
    (((bytes[0] ?? 0) << 24) |
      ((bytes[1] ?? 0) << 16) |
      ((bytes[2] ?? 0) << 8) |
      (bytes[3] ?? 0)) >>>
    0;
  // Size 1 means a 64-bit length follows; 0 means "to end of file". Both are legal.
  if (size !== 0 && size !== 1 && size < 8) {
    return false;
  }
  return MP4_LEADING_BOXES.has(ascii(bytes, 4, 4));
}

/**
 * ADTS-framed AAC ("packed audio" in HLS): a 12-bit sync word, then a sampling-rate
 * index that is actually assigned.
 *
 * The extra check matters — 0xFF 0xF- alone appears often enough in arbitrary binary
 * to be worthless on its own.
 */
function isAdts(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 7) {
    return false;
  }
  if ((bytes[0] ?? 0) !== 0xff || ((bytes[1] ?? 0) & 0xf0) !== 0xf0) {
    return false;
  }
  const rateIndex = ((bytes[2] ?? 0) & 0x3c) >> 2;
  return rateIndex <= 12;
}

/**
 * Identify a resource from its leading bytes.
 *
 * Order matters: the binary signatures are checked before the textual ones, because a
 * text test on binary input can produce a false positive far more easily than the
 * reverse.
 */
export function sniffFormat(bytes: Uint8Array): SniffedFormat | undefined {
  if (bytes.byteLength === 0) {
    return undefined;
  }
  // Matroska/WebM: the EBML header.
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'webm';
  }
  if (isTransportStream(bytes)) {
    return 'mpeg-ts';
  }
  if (isIsoBmff(bytes)) {
    return 'mp4';
  }
  if (isAdts(bytes)) {
    return 'adts';
  }

  const start = textStart(bytes);
  if (ascii(bytes, start, 7) === '#EXTM3U') {
    return 'hls';
  }
  // DASH: the root element, possibly behind an XML declaration or a comment.
  const head = ascii(bytes, start, Math.min(512, bytes.byteLength - start));
  if (/^<\?xml[\s\S]{0,400}?<MPD[\s>]/.test(head) || /^<MPD[\s>]/.test(head)) {
    return 'dash';
  }
  return undefined;
}

/**
 * Which kind of HLS playlist this is.
 *
 * A master lists renditions (`#EXT-X-STREAM-INF`); a media playlist lists segments
 * (`#EXTINF`). Both are `#EXTM3U`, and a player fetches the master and then the
 * rendition inside it — so a page yields both, and offering the user two entries for
 * one video is worse than offering one. The master is the one to keep: it carries every
 * rendition, which is what the quality chooser enumerates (§10.6).
 *
 * `undefined` when the prefix shows neither, which is not a judgement — a very long
 * header can push the first tag past what was read.
 */
export function sniffHlsRole(bytes: Uint8Array): HlsPlaylistRole | undefined {
  const text = ascii(bytes, 0, Math.min(bytes.byteLength, SNIFF_PREFIX_BYTES));
  if (text.includes('#EXT-X-STREAM-INF')) {
    return 'master';
  }
  return text.includes('#EXTINF') ? 'media' : undefined;
}

/** Whether a sniffed format is a manifest that assembly would have to read. */
export function isStreamManifestFormat(format: SniffedFormat | undefined): boolean {
  return format === 'hls' || format === 'dash';
}

/**
 * The file extension a sniffed format should be SAVED as.
 *
 * Deliberately not derived from the URL: a segment served as `.css` is still MPEG-TS,
 * and naming the saved file after the lie would produce a file nothing can open
 * (§10.7).
 */
export function containerOfFormat(format: SniffedFormat | undefined): string | undefined {
  switch (format) {
    case 'mpeg-ts':
      return 'ts';
    case 'mp4':
      return 'mp4';
    case 'webm':
      return 'webm';
    case 'adts':
      return 'aac';
    default:
      // A manifest is not a container: what a stream is saved as depends on the
      // segments it names, which are sniffed in turn.
      return undefined;
  }
}
