/**
 * Module: core/download/stream (fragmented-MP4 muxing)
 * Purpose: Combine a video-only and an audio-only fragmented-MP4 stream into one file
 *          (PROJECT_BIBLE.md §10.6). Most real-world DASH — and much HLS — keeps the
 *          two in separate tracks, which assembly previously refused rather than save
 *          as a video with no sound.
 * Restrictions: Domain layer — pure. Bytes in, bytes out: no I/O, no browser globals,
 *          no decoding and no re-encoding. Sample data is never touched, so this is a
 *          container operation and nothing more; it cannot and does not decrypt
 *          anything (§6, ADR-005).
 * Approach: Each fragment is copied VERBATIM, so every offset inside it — `trun`'s
 *          `data_offset` above all — stays valid. Only three fixed-width fields are
 *          rewritten: the audio track's id in its `tkhd` and in each of its `tfhd`
 *          boxes, and every fragment's `mfhd` sequence number. Nothing changes size,
 *          which is what makes verbatim copying safe.
 * Dependencies: shared/result.
 * Public API: MP4_MAX_BOX_DEPTH, Mp4Track, MuxRequest, muxFragmentedMp4,
 *          splitFragmentedMp4, isFragmentedMp4.
 */
import { err, ok, type Result } from '@shared/result';
import { StreamAssemblyError } from '@core/download/errors';

/** Guard against a malformed file describing boxes inside boxes forever (§10.9). */
export const MP4_MAX_BOX_DEPTH = 8;

const VIDEO_TRACK_ID = 1;
const AUDIO_TRACK_ID = 2;

interface Box {
  readonly type: string;
  /** Offset of the box header within the buffer it was read from. */
  readonly start: number;
  readonly size: number;
}

export interface Mp4Track {
  /** `ftyp` + `moov`: the initialisation segment. */
  readonly init: Uint8Array;
  /** Each entry is one `moof` with its `mdat`, exactly as it arrived. */
  readonly fragments: readonly Uint8Array[];
}

export interface MuxRequest {
  readonly video: Mp4Track;
  readonly audio: Mp4Track;
}

function fail(message: string, code: string): StreamAssemblyError {
  return new StreamAssemblyError(message, {
    code,
    messageKey: 'error.download.stream.tracks',
    retryable: false,
  });
}

function u32(bytes: Uint8Array, at: number): number {
  return (
    (((bytes[at] ?? 0) << 24) |
      ((bytes[at + 1] ?? 0) << 16) |
      ((bytes[at + 2] ?? 0) << 8) |
      (bytes[at + 3] ?? 0)) >>>
    0
  );
}

function writeU32(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = (value >>> 24) & 0xff;
  bytes[at + 1] = (value >>> 16) & 0xff;
  bytes[at + 2] = (value >>> 8) & 0xff;
  bytes[at + 3] = value & 0xff;
}

function typeAt(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(
    bytes[at] ?? 0,
    bytes[at + 1] ?? 0,
    bytes[at + 2] ?? 0,
    bytes[at + 3] ?? 0,
  );
}

/** The boxes directly inside `[from, to)`. Malformed input yields what was readable. */
function childBoxes(bytes: Uint8Array, from: number, to: number): readonly Box[] {
  const found: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = u32(bytes, at);
    if (size === 0) {
      size = to - at;
    }
    if (size === 1) {
      // 64-bit size: the extended field follows the type. Anything this large is not
      // something we are going to rewrite, so it is only skipped correctly.
      const high = u32(bytes, at + 8);
      const low = u32(bytes, at + 12);
      size = high * 0x100000000 + low;
    }
    if (size < 8 || at + size > to) {
      break;
    }
    found.push({ type: typeAt(bytes, at + 4), start: at, size });
    at += size;
  }
  return found;
}

/** Find one box by a nested type path, e.g. `['moov', 'trak', 'tkhd']`. */
function findBox(
  bytes: Uint8Array,
  path: readonly string[],
  from = 0,
  to = bytes.length,
  depth = 0,
): Box | undefined {
  const [head, ...rest] = path;
  if (head === undefined || depth >= MP4_MAX_BOX_DEPTH) {
    return undefined;
  }
  for (const box of childBoxes(bytes, from, to)) {
    if (box.type !== head) {
      continue;
    }
    if (rest.length === 0) {
      return box;
    }
    return findBox(bytes, rest, box.start + 8, box.start + box.size, depth + 1);
  }
  return undefined;
}

/** Whether these bytes look like a fragmented MP4 initialisation segment. */
export function isFragmentedMp4(bytes: Uint8Array): boolean {
  return findBox(bytes, ['moov']) !== undefined || findBox(bytes, ['moof']) !== undefined;
}

/**
 * Split a fragmented MP4 into its initialisation segment and its fragments.
 *
 * `styp`, `sidx`, `mfra` and friends are dropped: they index the file by byte offset,
 * and those offsets do not survive being interleaved with another track.
 */
export function splitFragmentedMp4(bytes: Uint8Array): Mp4Track {
  const initParts: Uint8Array[] = [];
  const fragments: Uint8Array[] = [];
  let pendingMoof: Box | undefined;

  for (const box of childBoxes(bytes, 0, bytes.length)) {
    if (box.type === 'ftyp' || box.type === 'moov') {
      initParts.push(bytes.subarray(box.start, box.start + box.size));
    } else if (box.type === 'moof') {
      pendingMoof = box;
    } else if (box.type === 'mdat' && pendingMoof !== undefined) {
      fragments.push(bytes.subarray(pendingMoof.start, box.start + box.size));
      pendingMoof = undefined;
    }
  }
  return { init: concat(initParts), fragments };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength);
  writeU32(out, 0, out.byteLength);
  for (let index = 0; index < 4; index += 1) {
    out[4 + index] = type.charCodeAt(index);
  }
  out.set(payload, 8);
  return out;
}

/** A `trex` declaring per-track defaults for a fragmented file. */
function trex(trackId: number): Uint8Array {
  const payload = new Uint8Array(24);
  writeU32(payload, 0, 0); // version + flags
  writeU32(payload, 4, trackId);
  writeU32(payload, 8, 1); // default_sample_description_index
  return box('trex', payload);
}

/** Rewrite the track id inside a copied `trak`. */
function setTrakId(trak: Uint8Array, trackId: number): Result<void, StreamAssemblyError> {
  const tkhd = findBox(trak, ['tkhd'], 8, trak.byteLength);
  if (tkhd === undefined) {
    return err(fail('A track is missing its header (tkhd)', 'stream-mux-no-tkhd'));
  }
  // tkhd payload: version(1) flags(3) creation modification track_ID …
  // The timestamps are 64-bit in version 1 and 32-bit in version 0.
  const version = trak[tkhd.start + 8] ?? 0;
  const at = tkhd.start + 12 + (version === 1 ? 16 : 8);
  if (at + 4 > tkhd.start + tkhd.size) {
    return err(fail('A track header is truncated', 'stream-mux-bad-tkhd'));
  }
  writeU32(trak, at, trackId);
  return ok(undefined);
}

/** Rewrite one fragment's track id and sequence number, in place, same widths. */
function retagFragment(
  fragment: Uint8Array,
  trackId: number,
  sequence: number,
): Result<Uint8Array, StreamAssemblyError> {
  const copy = fragment.slice();
  const moof = findBox(copy, ['moof']);
  if (moof === undefined) {
    return err(fail('A fragment is missing its header (moof)', 'stream-mux-no-moof'));
  }
  const inner = { from: moof.start + 8, to: moof.start + moof.size };
  const mfhd = findBox(copy, ['mfhd'], inner.from, inner.to);
  const traf = findBox(copy, ['traf'], inner.from, inner.to);
  if (mfhd === undefined || traf === undefined) {
    return err(fail('A fragment header is incomplete', 'stream-mux-bad-moof'));
  }
  // mfhd payload: version+flags(4) sequence_number(4)
  writeU32(copy, mfhd.start + 12, sequence);
  // Every traf in the fragment belongs to the same track here: these are single-track
  // segments by construction, which is why they had to be muxed in the first place.
  for (const child of childBoxes(copy, inner.from, inner.to)) {
    if (child.type !== 'traf') {
      continue;
    }
    const tfhd = findBox(copy, ['tfhd'], child.start + 8, child.start + child.size);
    if (tfhd === undefined) {
      return err(fail('A fragment is missing a track header (tfhd)', 'stream-mux-no-tfhd'));
    }
    // tfhd payload: version+flags(4) track_ID(4)
    writeU32(copy, tfhd.start + 12, trackId);
  }
  return ok(copy);
}

/** Build the combined initialisation segment: one `moov` carrying both tracks. */
function mergeInit(video: Uint8Array, audio: Uint8Array): Result<Uint8Array, StreamAssemblyError> {
  const ftyp = findBox(video, ['ftyp']);
  const videoMoov = findBox(video, ['moov']);
  const audioMoov = findBox(audio, ['moov']);
  if (ftyp === undefined || videoMoov === undefined || audioMoov === undefined) {
    return err(fail('A track is not a fragmented MP4 (no ftyp/moov)', 'stream-mux-not-fragmented'));
  }

  let mvhd: Uint8Array | undefined;
  const videoTraks: Uint8Array[] = [];
  for (const child of childBoxes(video, videoMoov.start + 8, videoMoov.start + videoMoov.size)) {
    if (child.type === 'mvhd') {
      mvhd = video.slice(child.start, child.start + child.size);
    } else if (child.type === 'trak') {
      const trak = video.slice(child.start, child.start + child.size);
      const tagged = setTrakId(trak, VIDEO_TRACK_ID);
      if (!tagged.ok) {
        return err(tagged.error);
      }
      videoTraks.push(trak);
    }
    // `mvex` is rebuilt below; anything else (udta, iods, sidx hints) is dropped.
  }

  let audioTrak: Uint8Array | undefined;
  for (const child of childBoxes(audio, audioMoov.start + 8, audioMoov.start + audioMoov.size)) {
    if (child.type === 'trak') {
      audioTrak = audio.slice(child.start, child.start + child.size);
      break;
    }
  }
  if (mvhd === undefined || videoTraks.length === 0 || audioTrak === undefined) {
    return err(fail('A track is missing its movie header', 'stream-mux-no-moov-children'));
  }
  const taggedAudio = setTrakId(audioTrak, AUDIO_TRACK_ID);
  if (!taggedAudio.ok) {
    return err(taggedAudio.error);
  }

  // mvhd's last field is next_track_ID; both tracks are accounted for now.
  writeU32(mvhd, mvhd.byteLength - 4, AUDIO_TRACK_ID + 1);

  const mvex = box('mvex', concat([trex(VIDEO_TRACK_ID), trex(AUDIO_TRACK_ID)]));
  const moov = box('moov', concat([mvhd, ...videoTraks, audioTrak, mvex]));
  return ok(concat([video.subarray(ftyp.start, ftyp.start + ftyp.size), moov]));
}

/**
 * Mux a video-only and an audio-only fragmented MP4 into one file.
 *
 * Fragments are interleaved in playback order — video, then audio, for each index —
 * which is what a player expects and what keeps memory flat: nothing is buffered
 * beyond the fragment being copied.
 */
export function muxFragmentedMp4(request: MuxRequest): Result<Uint8Array[], StreamAssemblyError> {
  if (request.video.fragments.length === 0 || request.audio.fragments.length === 0) {
    return err(fail('A track has no fragments to mux', 'stream-mux-empty'));
  }
  const init = mergeInit(request.video.init, request.audio.init);
  if (!init.ok) {
    return err(init.error);
  }

  const parts: Uint8Array[] = [init.value];
  const longest = Math.max(request.video.fragments.length, request.audio.fragments.length);
  let sequence = 1;
  for (let index = 0; index < longest; index += 1) {
    const video = request.video.fragments[index];
    if (video !== undefined) {
      const tagged = retagFragment(video, VIDEO_TRACK_ID, sequence);
      if (!tagged.ok) {
        return err(tagged.error);
      }
      parts.push(tagged.value);
      sequence += 1;
    }
    const audio = request.audio.fragments[index];
    if (audio !== undefined) {
      const tagged = retagFragment(audio, AUDIO_TRACK_ID, sequence);
      if (!tagged.ok) {
        return err(tagged.error);
      }
      parts.push(tagged.value);
      sequence += 1;
    }
  }
  return ok(parts);
}
