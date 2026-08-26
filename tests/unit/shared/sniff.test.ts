/**
 * Content sniffing (PROJECT_BIBLE.md §5.1, §9.1).
 *
 * The case that forced this module into existence is the first test: a real video host
 * serves its HLS playlist as `.txt` / `text/plain` and its MPEG-TS segments as `.css` /
 * `text/css`. Every name-based check in this codebase answered wrong for it. These
 * tests are therefore written against BYTES, and include the false positives that a
 * naive signature check would produce.
 */
import { describe, expect, it } from 'vitest';
import {
  containerOfFormat,
  isStreamManifestFormat,
  sniffFormat,
  SNIFF_PREFIX_BYTES,
} from '@shared/utils/sniff';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A transport stream: the sync byte at 0, 188 and 376, as a real one has. */
function transportStream(packets = 3): Uint8Array {
  const bytes = new Uint8Array(188 * packets).fill(0x11);
  for (let index = 0; index < packets; index += 1) {
    bytes[index * 188] = 0x47;
  }
  return bytes;
}

function isoBmff(type: string, size = 32): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes[0] = (size >>> 24) & 0xff;
  bytes[1] = (size >>> 16) & 0xff;
  bytes[2] = (size >>> 8) & 0xff;
  bytes[3] = size & 0xff;
  for (let index = 0; index < 4; index += 1) {
    bytes[4 + index] = type.charCodeAt(index);
  }
  return bytes;
}

describe('shared/utils content sniffing', () => {
  it('recognises an HLS playlist however it is named or typed', () => {
    // The real case: served as text/plain from a .txt URL.
    expect(sniffFormat(utf8('#EXTM3U\n#EXT-X-VERSION:3\n'))).toBe('hls');
  });

  it('recognises MPEG-TS segments that claim to be stylesheets', () => {
    // The real case: `.css`, `content-type: text/css`, first byte 0x47.
    expect(sniffFormat(transportStream())).toBe('mpeg-ts');
    expect(containerOfFormat(sniffFormat(transportStream()))).toBe('ts');
  });

  it('does not call a lone 0x47 a transport stream', () => {
    // One byte in 256 is 0x47 by chance; without the repetition this check would
    // misfire on ordinary binary data.
    const noise = new Uint8Array(600).fill(0x22);
    noise[0] = 0x47;
    expect(sniffFormat(noise)).toBeUndefined();
  });

  it('accepts two sync bytes when the prefix is too short for three', () => {
    expect(sniffFormat(transportStream(2).subarray(0, 300))).toBe('mpeg-ts');
  });

  it('recognises every ISO-BMFF box that may open a file or segment', () => {
    for (const type of ['ftyp', 'styp', 'moof', 'moov', 'sidx']) {
      expect(sniffFormat(isoBmff(type)), type).toBe('mp4');
    }
    expect(containerOfFormat('mp4')).toBe('mp4');
  });

  it('rejects an ISO-BMFF-looking prefix whose box size is impossible', () => {
    const bad = isoBmff('ftyp');
    bad[0] = 0;
    bad[1] = 0;
    bad[2] = 0;
    bad[3] = 4; // a box cannot be smaller than its own header
    expect(sniffFormat(bad)).toBeUndefined();
  });

  it('reads a playlist behind a byte-order mark or leading whitespace', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('#EXTM3U\n')]);
    expect(sniffFormat(bom)).toBe('hls');
    expect(sniffFormat(utf8('\n\n   #EXTM3U\n'))).toBe('hls');
  });

  it('recognises a DASH manifest with or without an XML declaration', () => {
    expect(sniffFormat(utf8('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">'))).toBe(
      'dash',
    );
    expect(sniffFormat(utf8('<?xml version="1.0" encoding="utf-8"?>\n<MPD type="static">'))).toBe(
      'dash',
    );
  });

  it('does not call arbitrary XML a DASH manifest', () => {
    expect(sniffFormat(utf8('<?xml version="1.0"?><rss version="2.0"><channel>'))).toBeUndefined();
    expect(sniffFormat(utf8('<!DOCTYPE html><html><head><title>x</title>'))).toBeUndefined();
  });

  it('recognises WebM by its EBML header', () => {
    const ebml = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]);
    expect(sniffFormat(ebml)).toBe('webm');
    expect(containerOfFormat('webm')).toBe('webm');
  });

  it('recognises ADTS-framed AAC, and rejects a sync word with a reserved rate', () => {
    const adts = new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc, 0x00]);
    expect(sniffFormat(adts)).toBe('adts');
    expect(containerOfFormat('adts')).toBe('aac');

    const reserved = new Uint8Array([0xff, 0xf1, 0x7c, 0x80, 0x00, 0x1f, 0xfc, 0x00]);
    expect(sniffFormat(reserved)).toBeUndefined();
  });

  it('says nothing about bytes it does not recognise, rather than guessing', () => {
    expect(sniffFormat(new Uint8Array(0))).toBeUndefined();
    expect(sniffFormat(utf8('body { color: red; }'))).toBeUndefined();
    expect(sniffFormat(utf8('{"success":true}'))).toBeUndefined();
    expect(sniffFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
  });

  it('classifies manifests apart from containers', () => {
    expect(isStreamManifestFormat('hls')).toBe(true);
    expect(isStreamManifestFormat('dash')).toBe(true);
    expect(isStreamManifestFormat('mpeg-ts')).toBe(false);
    expect(isStreamManifestFormat(undefined)).toBe(false);
    // A manifest is not something to save: what the file becomes depends on the
    // segments it names.
    expect(containerOfFormat('hls')).toBeUndefined();
  });

  it('needs no more than the declared prefix to decide anything', () => {
    // 377 bytes is the longest check (three sync bytes, 188 apart).
    expect(SNIFF_PREFIX_BYTES).toBeGreaterThanOrEqual(377);
    expect(sniffFormat(transportStream().subarray(0, SNIFF_PREFIX_BYTES))).toBe('mpeg-ts');
  });
});
