/**
 * Minimal fragmented-MP4 builders and readers for the stream tests.
 *
 * Enough box structure to exercise muxing — ftyp/moov/tkhd/mvhd, moof/mfhd/traf/tfhd,
 * mdat — with no sample data and no codec configuration. Real h264/aac coverage lives
 * in `mux.test.ts`, which generates media with ffmpeg and has ffprobe judge the result.
 *
 * Not a test file.
 */

export function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength);
  new DataView(out.buffer).setUint32(0, out.byteLength);
  for (let index = 0; index < 4; index += 1) {
    out[4 + index] = type.charCodeAt(index);
  }
  out.set(payload, 8);
  return out;
}

/** A short byte array, spelled inline. */
export function bytesOf(...values: readonly number[]): Uint8Array {
  return new Uint8Array(values);
}

export function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

export function joinBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** A version-0 `tkhd` carrying the given track id. */
export function tkhd(trackId: number): Uint8Array {
  return box('tkhd', joinBytes(u32(0), u32(1000), u32(1000), u32(trackId), new Uint8Array(60)));
}

export function mvhd(nextTrackId: number): Uint8Array {
  return box('mvhd', joinBytes(u32(0), new Uint8Array(92), u32(nextTrackId)));
}

/** `ftyp` + `moov` with one track: an initialisation segment. */
export function initSegment(trackId = 1): Uint8Array {
  return joinBytes(
    box('ftyp', joinBytes(new Uint8Array([0x69, 0x73, 0x6f, 0x36]), u32(0))),
    box('moov', joinBytes(mvhd(trackId + 1), box('trak', tkhd(trackId)))),
  );
}

/** One `moof` plus its `mdat`. */
export function fragment(trackId: number, sequence: number, payload: Uint8Array): Uint8Array {
  const moof = box(
    'moof',
    joinBytes(
      box('mfhd', joinBytes(u32(0), u32(sequence))),
      box('traf', joinBytes(box('tfhd', joinBytes(u32(0), u32(trackId))))),
    ),
  );
  return joinBytes(moof, box('mdat', payload));
}

export interface ReadBox {
  readonly type: string;
  readonly start: number;
  readonly size: number;
}

/** The boxes directly inside `data`. */
export function readBoxes(data: Uint8Array): ReadBox[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const found: ReadBox[] = [];
  let at = 0;
  while (at + 8 <= data.byteLength) {
    const size = view.getUint32(at);
    const type = String.fromCharCode(...data.subarray(at + 4, at + 8));
    if (size < 8 || at + size > data.byteLength) {
      break;
    }
    found.push({ type, start: at, size });
    at += size;
  }
  return found;
}

/** Every `tfhd` track id in the file, in order. */
export function trackIdsOf(data: Uint8Array): number[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ids: number[] = [];
  for (const top of readBoxes(data)) {
    if (top.type !== 'moof') {
      continue;
    }
    for (const child of readBoxes(data.subarray(top.start + 8, top.start + top.size))) {
      if (child.type !== 'traf') {
        continue;
      }
      const trafAt = top.start + 8 + child.start;
      for (const inner of readBoxes(data.subarray(trafAt + 8, trafAt + child.size))) {
        if (inner.type === 'tfhd') {
          ids.push(view.getUint32(trafAt + 8 + inner.start + 12));
        }
      }
    }
  }
  return ids;
}

/** Every `mfhd` sequence number in the file, in order. */
export function sequencesOf(data: Uint8Array): number[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const sequences: number[] = [];
  for (const top of readBoxes(data)) {
    if (top.type !== 'moof') {
      continue;
    }
    for (const child of readBoxes(data.subarray(top.start + 8, top.start + top.size))) {
      if (child.type === 'mfhd') {
        sequences.push(view.getUint32(top.start + 8 + child.start + 12));
      }
    }
  }
  return sequences;
}
