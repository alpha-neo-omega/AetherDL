/**
 * A minimal but REAL MPEG-2 Transport Stream writer, for the demux tests.
 *
 * Real in the parts that matter: proper 188-byte packets with sync bytes, adaptation
 * stuffing and continuity, a PAT pointing at a PMT, a PMT declaring elementary streams,
 * PES packets carrying 33-bit PTS/DTS, Annex B video with a genuine H.264 parameter set,
 * and ADTS-framed audio. The compressed payloads are stand-ins — the demuxer never
 * decodes them — but everything the demuxer reads is the real format, so a test that
 * passes here is testing the same code paths a CDN's bytes take.
 *
 * The parameter sets are the ones `ffmpeg` produced for a 320x240 baseline clip; the
 * picture size is read out of them, so they cannot be invented.
 *
 * Not a test file.
 */

export const TS_PACKET_SIZE = 188;
export const PMT_PID = 0x1000;
export const VIDEO_PID = 0x0100;
export const AUDIO_PID = 0x0101;

export const STREAM_TYPE_H264 = 0x1b;
export const STREAM_TYPE_AAC = 0x0f;
export const STREAM_TYPE_AC3 = 0x81;

/** A real SPS: baseline profile, 320x240 (ffmpeg, libx264). */
export const REAL_SPS = new Uint8Array([
  0x67, 0x42, 0xc0, 0x0c, 0xda, 0x05, 0x07, 0xec, 0x04, 0x40, 0x00, 0x00, 0x03, 0x00, 0x40, 0x00,
  0x00, 0x07, 0x83, 0xc5, 0x0a, 0xa8,
]);
export const REAL_PPS = new Uint8Array([0x68, 0xce, 0x0f, 0xc8]);
/** What {@link REAL_SPS} describes; asserted by the tests that read it. */
export const REAL_SPS_WIDTH = 320;
export const REAL_SPS_HEIGHT = 240;

/**
 * A real HIGH-profile SPS, for a 1280x718 picture (ffmpeg, libx264 `-profile:v high`).
 *
 * Two things this exercises that the baseline set cannot: the chroma-format and
 * bit-depth fields that only a high profile carries, and frame **cropping** — 718 is
 * not a multiple of 16, so the coded height is 720 and the crop has to be applied or
 * the track header claims the wrong size.
 */
export const HIGH_PROFILE_SPS = new Uint8Array([
  0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40, 0x50, 0x05, 0xbf, 0xac, 0x04, 0x40, 0x00, 0x00, 0x03,
  0x00, 0x40, 0x00, 0x00, 0x05, 0x03, 0xc6, 0x0c, 0x65, 0x80,
]);
export const HIGH_PROFILE_PPS = new Uint8Array([0x68, 0xeb, 0xe3, 0xcb]);
export const HIGH_PROFILE_WIDTH = 1280;
export const HIGH_PROFILE_HEIGHT = 718;

/**
 * A real high-profile SPS from an encode with custom quantisation matrices
 * (ffmpeg, libx264 `-x264-params cqm=jvt`), for a 176x144 picture.
 *
 * Included because that encoder setting is what puts scaling-list data in the
 * bitstream, and a parser that skips it wrongly reads the picture size from the wrong
 * bits — which produces a plausible number, not an error.
 */
export const SCALING_MATRIX_SPS = new Uint8Array([
  0x67, 0x64, 0x00, 0x0a, 0xac, 0xd9, 0x42, 0xc4, 0xec, 0x04, 0x40, 0x00, 0x00, 0x03, 0x00, 0x40,
  0x00, 0x00, 0x05, 0x03, 0xc4, 0x89, 0x65, 0x80,
]);
export const SCALING_MATRIX_WIDTH = 176;
export const SCALING_MATRIX_HEIGHT = 144;

export function bytes(...values: readonly number[]): Uint8Array {
  return new Uint8Array(values);
}

export function join(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** Pack a payload into 188-byte packets, stuffing the last one via its adaptation field. */
export function packets(pid: number, payload: Uint8Array, startCounter = 0): Uint8Array {
  const out: Uint8Array[] = [];
  let at = 0;
  let counter = startCounter;
  let first = true;

  while (at < payload.byteLength) {
    const remaining = payload.byteLength - at;
    const packet = new Uint8Array(TS_PACKET_SIZE).fill(0xff);
    packet[0] = 0x47;
    packet[1] = ((first ? 0x40 : 0) | ((pid >> 8) & 0x1f)) & 0xff;
    packet[2] = pid & 0xff;
    if (remaining >= TS_PACKET_SIZE - 4) {
      packet[3] = (0x10 | (counter & 0x0f)) & 0xff;
      packet.set(payload.subarray(at, at + TS_PACKET_SIZE - 4), 4);
      at += TS_PACKET_SIZE - 4;
    } else {
      // Adaptation field carries the stuffing so the payload still ends the packet.
      const stuffing = TS_PACKET_SIZE - 4 - 1 - remaining;
      packet[3] = (0x30 | (counter & 0x0f)) & 0xff;
      packet[4] = stuffing;
      if (stuffing > 0) {
        packet[5] = 0x00; // flags
        packet.fill(0xff, 6, 5 + stuffing);
      }
      packet.set(payload.subarray(at), 5 + stuffing);
      at = payload.byteLength;
    }
    counter = (counter + 1) & 0x0f;
    first = false;
    out.push(packet);
  }
  return join(...out);
}

/**
 * A packet with an adaptation field and NO payload — a PCR-only packet, which every
 * real transport stream is full of.
 */
export function adaptationOnlyPacket(pid: number): Uint8Array {
  const packet = new Uint8Array(TS_PACKET_SIZE).fill(0xff);
  packet[0] = 0x47;
  packet[1] = (pid >> 8) & 0x1f;
  packet[2] = pid & 0xff;
  packet[3] = 0x20; // adaptation field only
  packet[4] = TS_PACKET_SIZE - 5;
  packet[5] = 0x10; // PCR flag
  return packet;
}

/** A PSI section, with its pointer field and a placeholder CRC. */
function section(tableId: number, body: Uint8Array): Uint8Array {
  // section_length covers everything after it, including the 4-byte CRC.
  const length = 5 + body.byteLength + 4;
  return join(
    bytes(0x00), // pointer field
    bytes(tableId, 0xb0 | ((length >> 8) & 0x0f), length & 0xff),
    bytes(0x00, 0x01), // table id extension
    bytes(0xc1, 0x00, 0x00), // version/current, section numbers
    body,
    bytes(0x00, 0x00, 0x00, 0x00), // CRC-32 — not checked by the demuxer
  );
}

export function patPacket(programMapPid = PMT_PID): Uint8Array {
  const body = join(
    bytes(0x00, 0x01),
    bytes(0xe0 | ((programMapPid >> 8) & 0x1f), programMapPid & 0xff),
  );
  return packets(0, section(0x00, body));
}

export interface PmtStream {
  readonly streamType: number;
  readonly pid: number;
}

export interface PmtOptions {
  readonly pid?: number;
  /** Bytes of program-level descriptors, which a real PMT frequently carries. */
  readonly programInfo?: Uint8Array;
  /** Bytes of per-stream descriptors (language tags, registration, and so on). */
  readonly streamInfo?: Uint8Array;
}

export function pmtPacket(
  streams: readonly PmtStream[],
  options: PmtOptions | number = {},
): Uint8Array {
  const settings = typeof options === 'number' ? { pid: options } : options;
  const programInfo = settings.programInfo ?? new Uint8Array();
  const streamInfo = settings.streamInfo ?? new Uint8Array();
  const body = join(
    bytes(0xe0 | ((VIDEO_PID >> 8) & 0x1f), VIDEO_PID & 0xff), // PCR PID
    bytes(0xf0 | ((programInfo.byteLength >> 8) & 0x0f), programInfo.byteLength & 0xff),
    programInfo,
    ...streams.map((stream) =>
      join(
        bytes(stream.streamType),
        bytes(0xe0 | ((stream.pid >> 8) & 0x1f), stream.pid & 0xff),
        bytes(0xf0 | ((streamInfo.byteLength >> 8) & 0x0f), streamInfo.byteLength & 0xff),
        streamInfo,
      ),
    ),
  );
  return packets(settings.pid ?? PMT_PID, section(0x02, body));
}

/** A 33-bit timestamp, in the five-byte form a PES header uses. */
function timestamp(marker: number, value: number): Uint8Array {
  const high = Math.floor(value / 1_073_741_824) & 0x07;
  const middle = Math.floor(value / 32_768) & 0x7fff;
  const low = value & 0x7fff;
  return bytes(
    ((marker << 4) | (high << 1) | 1) & 0xff,
    (middle >> 7) & 0xff,
    (((middle & 0x7f) << 1) | 1) & 0xff,
    (low >> 7) & 0xff,
    (((low & 0x7f) << 1) | 1) & 0xff,
  );
}

export interface PesOptions {
  readonly streamId?: number;
  readonly pts: number;
  readonly dts?: number;
}

export function pes(payload: Uint8Array, options: PesOptions): Uint8Array {
  const hasDts = options.dts !== undefined && options.dts !== options.pts;
  const header = hasDts
    ? join(timestamp(0x3, options.pts), timestamp(0x1, options.dts ?? options.pts))
    : timestamp(0x2, options.pts);
  const packetLength = 3 + header.byteLength + payload.byteLength;
  return join(
    bytes(0x00, 0x00, 0x01, options.streamId ?? 0xe0),
    bytes((packetLength >> 8) & 0xff, packetLength & 0xff),
    bytes(0x80, hasDts ? 0xc0 : 0x80, header.byteLength),
    header,
    payload,
  );
}

/** Annex B: each NAL prefixed with a 4-byte start code. */
export function annexB(...nals: readonly Uint8Array[]): Uint8Array {
  return join(...nals.flatMap((nal) => [bytes(0x00, 0x00, 0x00, 0x01), nal]));
}

/** A NAL of the given type, with `length` bytes of stand-in payload. */
export function nal(type: number, length = 8, fill = 0x42): Uint8Array {
  const out = new Uint8Array(1 + length).fill(fill);
  out[0] = type & 0x1f;
  return out;
}

export interface AdtsOptions {
  /** Sampling-frequency index; 4 is 44100 Hz. */
  readonly rateIndex?: number;
  readonly channels?: number;
  readonly payloadBytes?: number;
  /** Emit the 9-byte protected header instead of the 7-byte one. */
  readonly withCrc?: boolean;
}

/** One ADTS frame: a real 7- or 9-byte header over stand-in payload. */
export function adtsFrame(options: AdtsOptions = {}): Uint8Array {
  const rateIndex = options.rateIndex ?? 4;
  const channels = options.channels ?? 2;
  const payload = new Uint8Array(options.payloadBytes ?? 16).fill(0x21);
  // With protection present the header is two bytes longer and carries a CRC.
  const withCrc = options.withCrc ?? false;
  const frameLength = (withCrc ? 9 : 7) + payload.byteLength;
  const header = bytes(
    0xff,
    withCrc ? 0xf0 : 0xf1, // sync, MPEG-4; the low bit clear means "CRC present"
    // profile (AAC LC = 1 → stored as 01), rate index, channel config high bit
    ((1 << 6) | (rateIndex << 2) | ((channels >> 2) & 0x01)) & 0xff,
    (((channels & 0x03) << 6) | ((frameLength >> 11) & 0x03)) & 0xff,
    (frameLength >> 3) & 0xff,
    (((frameLength & 0x07) << 5) | 0x1f) & 0xff,
    0xfc,
  );
  return withCrc ? join(header, bytes(0x00, 0x00), payload) : join(header, payload);
}
