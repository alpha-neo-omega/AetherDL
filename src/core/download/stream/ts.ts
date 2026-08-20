/**
 * Module: core/download/stream (MPEG-TS demultiplexing)
 * Purpose: Take MPEG-2 Transport Stream bytes apart into the elementary samples they
 *          carry — H.264 access units and AAC frames, each with its timestamps
 *          (PROJECT_BIBLE.md §10.6). This is the half of "join a split-track TS
 *          stream" that 1.3.0 said it did not do: a TS rendition cannot be joined to
 *          another track as-is, because its audio and video are interleaved into
 *          188-byte packets rather than laid out as tracks.
 * Restrictions: Domain layer — pure. Bytes in, samples out: no I/O, no browser
 *          globals, no decoding of picture or sound. Compressed sample data is copied
 *          VERBATIM; only the framing around it is read and rewritten, which is why
 *          this remains a container operation and cannot decrypt anything
 *          (§6, ADR-005). Every loop is bounded: a hostile stream must not be able to
 *          spin or grow memory without limit (§10.9).
 * Dependencies: shared/result, core/download/errors.
 * Public API: TS_PACKET_SIZE, TS_MAX_PACKETS, TS_CLOCK_HZ, ElementaryStreamKind,
 *          VideoConfig, AudioConfig, DemuxedSample, DemuxedTrack, DemuxResult,
 *          demuxMpegTs, demuxPackedAudio.
 */
import { err, ok, type Result } from '@shared/result';
import { StreamAssemblyError } from '@core/download/errors';

/** A transport packet is always this long, and always starts with 0x47. */
export const TS_PACKET_SIZE = 188;
const SYNC_BYTE = 0x47;

/**
 * Ceiling on packets read from one call — about 3.7 GB of transport stream, far past
 * the assembly ceiling, so it can only ever be reached by a malformed input (§10.9).
 */
export const TS_MAX_PACKETS = 20_000_000;

/** Program Association Table lives on PID 0 by definition. */
const PAT_PID = 0;

/** The stream types this understands; anything else is reported, not guessed at. */
const STREAM_TYPE_H264 = 0x1b;
const STREAM_TYPE_AAC_ADTS = 0x0f;

/** PES packets for audio/video start with this 3-byte code. */
const PES_START_CODE = 0x000001;

/** The 90 kHz clock every PTS/DTS in a transport stream is counted in. */
export const TS_CLOCK_HZ = 90_000;

export type ElementaryStreamKind = 'video' | 'audio';

export interface VideoConfig {
  readonly kind: 'video';
  /** Parameter sets, in the order they were seen; needed to build `avcC`. */
  readonly sps: readonly Uint8Array[];
  readonly pps: readonly Uint8Array[];
  readonly width: number;
  readonly height: number;
}

export interface AudioConfig {
  readonly kind: 'audio';
  /** AudioSpecificConfig, two bytes for every profile this accepts. */
  readonly audioSpecificConfig: Uint8Array;
  readonly sampleRate: number;
  readonly channels: number;
  /** Samples per AAC frame — 1024 for every profile this accepts. */
  readonly samplesPerFrame: number;
}

/**
 * One access unit (video) or one AAC frame (audio).
 *
 * `data` is the sample exactly as a fragmented MP4 wants it: for video, length-prefixed
 * NAL units; for audio, the raw AAC frame with its ADTS header removed. The bytes
 * inside are the encoder's, untouched.
 */
export interface DemuxedSample {
  readonly data: Uint8Array;
  /** Decode timestamp, in the track's own timescale. */
  readonly dts: number;
  /** Presentation timestamp, in the track's own timescale. */
  readonly pts: number;
  readonly isKeyframe: boolean;
}

export interface DemuxedTrack {
  readonly kind: ElementaryStreamKind;
  /** What a decoder needs before the first sample: parameter sets, or the ASC. */
  readonly config: VideoConfig | AudioConfig;
  /**
   * Timescale the timestamps are in: 90 kHz for video, the sample rate for audio, so
   * an AAC frame's duration is exactly 1024 and nothing drifts.
   */
  readonly timescale: number;
  readonly samples: readonly DemuxedSample[];
}

function fail(message: string, code: string): StreamAssemblyError {
  return new StreamAssemblyError(message, {
    code,
    messageKey: 'error.download.stream.tracks',
    retryable: false,
  });
}

/** AAC sampling frequencies, indexed as the ADTS header indexes them. */
const ADTS_SAMPLE_RATES: readonly number[] = [
  96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8000,
  7350,
];

/** Where the payload of a transport packet starts, or -1 when it carries none. */
function payloadStart(packet: Uint8Array): number {
  const hasAdaptation = (packet[3] ?? 0) & 0x20;
  const hasPayload = (packet[3] ?? 0) & 0x10;
  if (hasPayload === 0) {
    return -1;
  }
  if (hasAdaptation === 0) {
    return 4;
  }
  const adaptationLength = packet[4] ?? 0;
  const start = 5 + adaptationLength;
  return start >= TS_PACKET_SIZE ? -1 : start;
}

/** A 33-bit PTS/DTS, spread across five bytes with marker bits in between. */
function readTimestamp(bytes: Uint8Array, at: number): number {
  const high = ((bytes[at] ?? 0) >> 1) & 0x07;
  const middle = (((bytes[at + 1] ?? 0) << 8) | (bytes[at + 2] ?? 0)) >>> 1;
  const low = (((bytes[at + 3] ?? 0) << 8) | (bytes[at + 4] ?? 0)) >>> 1;
  // The top 3 bits sit above 30 bits of value, so this needs arithmetic rather than
  // shifts: `<< 30` in JavaScript works on 32-bit signed integers.
  return high * 1_073_741_824 + middle * 32_768 + low;
}

interface PesPacket {
  readonly payload: Uint8Array;
  readonly pts: number | undefined;
  readonly dts: number | undefined;
}

/** Read one assembled PES packet: its timestamps, and the elementary bytes after them. */
function parsePes(bytes: Uint8Array): PesPacket | undefined {
  if (bytes.byteLength < 9) {
    return undefined;
  }
  const startCode = ((bytes[0] ?? 0) << 16) | ((bytes[1] ?? 0) << 8) | (bytes[2] ?? 0);
  if (startCode !== PES_START_CODE) {
    return undefined;
  }
  const flags = bytes[7] ?? 0;
  const headerLength = bytes[8] ?? 0;
  const payloadAt = 9 + headerLength;
  if (payloadAt > bytes.byteLength) {
    return undefined;
  }
  const hasPts = (flags & 0x80) !== 0;
  const hasDts = (flags & 0x40) !== 0;
  const pts = hasPts && headerLength >= 5 ? readTimestamp(bytes, 9) : undefined;
  const dts = hasDts && headerLength >= 10 ? readTimestamp(bytes, 14) : undefined;
  return { payload: bytes.subarray(payloadAt), pts, dts };
}

/** Remove H.264 emulation-prevention bytes, so the RBSP can be read as a bit string. */
function unescapeRbsp(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.byteLength);
  let written = 0;
  let zeros = 0;
  for (let index = 0; index < nal.byteLength; index += 1) {
    const byte = nal[index] ?? 0;
    if (zeros === 2 && byte === 0x03) {
      zeros = 0;
      continue;
    }
    zeros = byte === 0 ? zeros + 1 : 0;
    out[written] = byte;
    written += 1;
  }
  return out.subarray(0, written);
}

/** Just enough of a bit reader to walk an SPS. */
class BitReader {
  private at = 0;

  constructor(private readonly bytes: Uint8Array) {}

  bit(): number {
    const byte = this.bytes[this.at >> 3] ?? 0;
    const value = (byte >> (7 - (this.at & 7))) & 1;
    this.at += 1;
    return value;
  }

  bits(count: number): number {
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      value = value * 2 + this.bit();
    }
    return value;
  }

  /** Unsigned Exp-Golomb, bounded so a corrupt stream cannot spin here. */
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0 && zeros < 32 && this.at < this.bytes.byteLength * 8) {
      zeros += 1;
    }
    return zeros === 0 ? 0 : (1 << zeros) - 1 + this.bits(zeros);
  }

  se(): number {
    const value = this.ue();
    return value % 2 === 0 ? -(value / 2) : (value + 1) / 2;
  }

  get exhausted(): boolean {
    return this.at >= this.bytes.byteLength * 8;
  }
}

/** Skip a scaling-list, which appears inside an SPS that carries one. */
function skipScalingList(reader: BitReader, size: number): void {
  let lastScale = 8;
  let nextScale = 8;
  for (let index = 0; index < size; index += 1) {
    if (nextScale !== 0) {
      nextScale = (lastScale + reader.se() + 256) % 256;
    }
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
}

interface Dimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Read the coded picture size out of an SPS.
 *
 * The alternative was to trust the manifest's `RESOLUTION`, which is optional, often
 * absent, and sometimes wrong. A track header with the wrong size is a file that plays
 * stretched, so the size is taken from the bitstream itself.
 */
function dimensionsFromSps(sps: Uint8Array): Dimensions | undefined {
  // Byte 0 is the NAL header; the SPS payload follows.
  const reader = new BitReader(unescapeRbsp(sps.subarray(1)));
  const profile = reader.bits(8);
  reader.bits(8); // constraint flags + reserved
  reader.bits(8); // level
  reader.ue(); // seq_parameter_set_id
  let chromaFormat = 1;
  if (profile === 100 || profile === 110 || profile === 122 || profile === 244 || profile === 44) {
    chromaFormat = reader.ue();
    if (chromaFormat === 3) {
      reader.bit(); // separate_colour_plane_flag
    }
    reader.ue(); // bit_depth_luma_minus8
    reader.ue(); // bit_depth_chroma_minus8
    reader.bit(); // qpprime_y_zero_transform_bypass_flag
    if (reader.bit() === 1) {
      for (let index = 0; index < (chromaFormat !== 3 ? 8 : 12); index += 1) {
        if (reader.bit() === 1) {
          skipScalingList(reader, index < 6 ? 16 : 64);
        }
      }
    }
  }
  reader.ue(); // log2_max_frame_num_minus4
  const pictureOrderType = reader.ue();
  if (pictureOrderType === 0) {
    reader.ue(); // log2_max_pic_order_cnt_lsb_minus4
  } else if (pictureOrderType === 1) {
    reader.bit();
    reader.se();
    reader.se();
    const cycleLength = reader.ue();
    for (let index = 0; index < cycleLength && index < 256; index += 1) {
      reader.se();
    }
  }
  reader.ue(); // max_num_ref_frames
  reader.bit(); // gaps_in_frame_num_value_allowed_flag
  const widthInMbs = reader.ue() + 1;
  const heightInMapUnits = reader.ue() + 1;
  const frameMbsOnly = reader.bit();
  if (frameMbsOnly === 0) {
    reader.bit(); // mb_adaptive_frame_field_flag
  }
  reader.bit(); // direct_8x8_inference_flag
  let cropLeft = 0;
  let cropRight = 0;
  let cropTop = 0;
  let cropBottom = 0;
  if (reader.bit() === 1) {
    cropLeft = reader.ue();
    cropRight = reader.ue();
    cropTop = reader.ue();
    cropBottom = reader.ue();
  }
  if (reader.exhausted) {
    return undefined;
  }
  // Crop units depend on the chroma format and on frame/field coding.
  const subWidth = chromaFormat === 3 ? 1 : 2;
  const subHeight = chromaFormat === 1 ? 2 : 1;
  const cropUnitX = chromaFormat === 0 ? 1 : subWidth;
  const cropUnitY = (chromaFormat === 0 ? 1 : subHeight) * (2 - frameMbsOnly);
  const width = widthInMbs * 16 - (cropLeft + cropRight) * cropUnitX;
  const height = (2 - frameMbsOnly) * heightInMapUnits * 16 - (cropTop + cropBottom) * cropUnitY;
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/** Split an Annex B byte stream into its NAL units, without copying payloads. */
function annexBNals(bytes: Uint8Array): readonly Uint8Array[] {
  const nals: Uint8Array[] = [];
  let start = -1;
  let zeros = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const byte = bytes[index] ?? 0;
    if (byte === 0) {
      zeros += 1;
      continue;
    }
    if (byte === 1 && zeros >= 2) {
      if (start >= 0) {
        // The zero bytes belong to the NEXT start code, not to this NAL.
        nals.push(bytes.subarray(start, index - zeros));
      }
      start = index + 1;
      zeros = 0;
      continue;
    }
    zeros = 0;
  }
  if (start >= 0 && start < bytes.byteLength) {
    nals.push(bytes.subarray(start));
  }
  return nals;
}

const NAL_TYPE_IDR = 5;
const NAL_TYPE_SPS = 7;
const NAL_TYPE_PPS = 8;
const NAL_TYPE_AUD = 9;

/** Length-prefix a list of NAL units, the way a fragmented MP4 stores a sample. */
function toAvccSample(nals: readonly Uint8Array[]): Uint8Array {
  const total = nals.reduce((sum, nal) => sum + 4 + nal.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const nal of nals) {
    const length = nal.byteLength;
    out[at] = (length >>> 24) & 0xff;
    out[at + 1] = (length >>> 16) & 0xff;
    out[at + 2] = (length >>> 8) & 0xff;
    out[at + 3] = length & 0xff;
    out.set(nal, at + 4);
    at += 4 + length;
  }
  return out;
}

interface VideoAccumulator {
  readonly kind: 'video';
  readonly sps: Uint8Array[];
  readonly pps: Uint8Array[];
  readonly samples: DemuxedSample[];
}

interface AudioAccumulator {
  readonly kind: 'audio';
  readonly samples: DemuxedSample[];
  config?: AudioConfig;
}

/**
 * Turn one PES payload of H.264 into an access unit.
 *
 * Parameter sets are collected for `avcC` and dropped from the sample: a fragmented
 * MP4 carries them in the sample description, not in the mdat. Access-unit delimiters
 * go too — they describe framing this container already provides.
 */
function addVideoSample(track: VideoAccumulator, packet: PesPacket): void {
  const keep: Uint8Array[] = [];
  let isKeyframe = false;
  for (const nal of annexBNals(packet.payload)) {
    const type = (nal[0] ?? 0) & 0x1f;
    if (type === NAL_TYPE_SPS) {
      if (track.sps.length === 0) {
        track.sps.push(nal.slice());
      }
      continue;
    }
    if (type === NAL_TYPE_PPS) {
      if (track.pps.length === 0) {
        track.pps.push(nal.slice());
      }
      continue;
    }
    if (type === NAL_TYPE_AUD) {
      continue;
    }
    if (type === NAL_TYPE_IDR) {
      isKeyframe = true;
    }
    keep.push(nal);
  }
  if (keep.length === 0) {
    return;
  }
  const pts = packet.pts ?? packet.dts;
  const dts = packet.dts ?? packet.pts;
  if (pts === undefined || dts === undefined) {
    // A sample with no timestamp cannot be placed on a timeline; dropping it would
    // desynchronise everything after it, so the whole track is refused later.
    return;
  }
  track.samples.push({ data: toAvccSample(keep), pts, dts, isKeyframe });
}

/**
 * Split a PES payload of ADTS-framed AAC into frames.
 *
 * Each frame becomes one sample and the 7- or 9-byte ADTS header is discarded: an MP4
 * describes the format once, in `esds`, instead of repeating it per frame.
 */
function addAudioSamples(track: AudioAccumulator, packet: PesPacket): void {
  const bytes = packet.payload;
  const basePts = packet.pts ?? packet.dts;
  if (basePts === undefined) {
    return;
  }
  addAdtsFrames(track, bytes, basePts);
}

/** Read ADTS frames out of `bytes`, timing them from `basePts` on the 90 kHz clock. */
function addAdtsFrames(track: AudioAccumulator, bytes: Uint8Array, basePts: number): void {
  let at = 0;
  let frameIndex = 0;
  while (at + 7 <= bytes.byteLength) {
    // Sync: 12 bits set.
    if ((bytes[at] ?? 0) !== 0xff || ((bytes[at + 1] ?? 0) & 0xf0) !== 0xf0) {
      at += 1;
      continue;
    }
    const header = bytes[at + 1] ?? 0;
    const hasCrc = (header & 0x01) === 0;
    const headerLength = hasCrc ? 9 : 7;
    const frameLength =
      (((bytes[at + 3] ?? 0) & 0x03) << 11) |
      ((bytes[at + 4] ?? 0) << 3) |
      (((bytes[at + 5] ?? 0) & 0xe0) >> 5);
    if (frameLength < headerLength || at + frameLength > bytes.byteLength) {
      break;
    }
    if (track.config === undefined) {
      const profile = (((bytes[at + 2] ?? 0) & 0xc0) >> 6) + 1;
      const rateIndex = ((bytes[at + 2] ?? 0) & 0x3c) >> 2;
      const channels = (((bytes[at + 2] ?? 0) & 0x01) << 2) | (((bytes[at + 3] ?? 0) & 0xc0) >> 6);
      const sampleRate = ADTS_SAMPLE_RATES[rateIndex];
      if (sampleRate !== undefined && channels > 0) {
        // AudioSpecificConfig: 5 bits object type, 4 bits rate index, 4 bits channels.
        const asc = new Uint8Array(2);
        asc[0] = ((profile << 3) | (rateIndex >> 1)) & 0xff;
        asc[1] = (((rateIndex & 0x01) << 7) | (channels << 3)) & 0xff;
        track.config = {
          kind: 'audio',
          audioSpecificConfig: asc,
          sampleRate,
          channels,
          samplesPerFrame: 1024,
        };
      }
    }
    const sampleRate = track.config?.sampleRate;
    if (sampleRate === undefined) {
      break;
    }
    // Timestamps in the track's own timescale: an AAC frame is exactly 1024 samples,
    // so durations stay integers and nothing drifts across a long stream.
    const startInSamples = Math.round((basePts / TS_CLOCK_HZ) * sampleRate) + frameIndex * 1024;
    track.samples.push({
      data: bytes.subarray(at + headerLength, at + frameLength).slice(),
      pts: startInSamples,
      dts: startInSamples,
      isKeyframe: true,
    });
    at += frameLength;
    frameIndex += 1;
  }
}

/**
 * ID3 tags precede the audio in an HLS packed-audio segment; skip them.
 *
 * Their payload is arbitrary bytes, which can contain something that looks like an
 * ADTS sync word, so they are skipped by length rather than scanned past.
 */
function skipId3(bytes: Uint8Array, from: number): number {
  let at = from;
  while (
    at + 10 <= bytes.byteLength &&
    (bytes[at] ?? 0) === 0x49 &&
    (bytes[at + 1] ?? 0) === 0x44 &&
    (bytes[at + 2] ?? 0) === 0x33
  ) {
    // A synchsafe 28-bit size, seven bits per byte, plus the 10-byte header.
    const size =
      ((bytes[at + 6] ?? 0) << 21) |
      ((bytes[at + 7] ?? 0) << 14) |
      ((bytes[at + 8] ?? 0) << 7) |
      (bytes[at + 9] ?? 0);
    const footer = ((bytes[at + 5] ?? 0) & 0x10) !== 0 ? 10 : 0;
    at += 10 + size + footer;
  }
  return at;
}

/**
 * Demultiplex an HLS "packed audio" rendition: ADTS-framed AAC in a bare file, with no
 * transport stream and no PES around it (§10.6).
 *
 * A real shape, not a hypothetical one: an audio-only rendition is frequently served
 * as `.aac` rather than as `.ts`, and reading it as a transport stream finds nothing.
 * Timestamps start at zero, because a packed-audio segment carries none of its own
 * beyond an optional ID3 hint this does not need.
 */
export function demuxPackedAudio(bytes: Uint8Array): Result<DemuxResult, StreamAssemblyError> {
  const track: AudioAccumulator = { kind: 'audio', samples: [] };
  addAdtsFrames(track, bytes.subarray(skipId3(bytes, 0)), 0);
  if (track.samples.length === 0 || track.config === undefined) {
    return err(fail('No AAC frames were found in this audio rendition', 'stream-ts-no-tracks'));
  }
  return ok({
    tracks: [
      {
        kind: 'audio',
        timescale: track.config.sampleRate,
        config: track.config,
        samples: track.samples,
      },
    ],
    skippedStreamTypes: [],
  });
}

/** PID → what it carries, learned from the PMT. */
type PidKinds = Map<number, ElementaryStreamKind>;

/** Read the PAT's first program map PID. */
function programMapPidOf(payload: Uint8Array): number | undefined {
  // A section in a payload with the pointer field: skip it first.
  const pointer = payload[0] ?? 0;
  const section = payload.subarray(1 + pointer);
  const sectionLength = (((section[1] ?? 0) & 0x0f) << 8) | (section[2] ?? 0);
  // Entries start after the 8-byte section header and run to the 4-byte CRC.
  const end = Math.min(3 + sectionLength - 4, section.byteLength);
  for (let at = 8; at + 4 <= end; at += 4) {
    const programNumber = ((section[at] ?? 0) << 8) | (section[at + 1] ?? 0);
    const pid = (((section[at + 2] ?? 0) & 0x1f) << 8) | (section[at + 3] ?? 0);
    if (programNumber !== 0) {
      return pid;
    }
  }
  return undefined;
}

/** Read a PMT into the PIDs it declares and what each one carries. */
function elementaryPidsOf(payload: Uint8Array): PidKinds {
  const found: PidKinds = new Map();
  const pointer = payload[0] ?? 0;
  const section = payload.subarray(1 + pointer);
  const sectionLength = (((section[1] ?? 0) & 0x0f) << 8) | (section[2] ?? 0);
  const programInfoLength = (((section[10] ?? 0) & 0x0f) << 8) | (section[11] ?? 0);
  const end = Math.min(3 + sectionLength - 4, section.byteLength);
  let at = 12 + programInfoLength;
  while (at + 5 <= end) {
    const streamType = section[at] ?? 0;
    const pid = (((section[at + 1] ?? 0) & 0x1f) << 8) | (section[at + 2] ?? 0);
    const esInfoLength = (((section[at + 3] ?? 0) & 0x0f) << 8) | (section[at + 4] ?? 0);
    if (streamType === STREAM_TYPE_H264) {
      found.set(pid, 'video');
    } else if (streamType === STREAM_TYPE_AAC_ADTS) {
      found.set(pid, 'audio');
    }
    // Any other stream type — AC-3, HEVC, subtitles, private data — is left out
    // rather than guessed at. What is left out is reported by the caller (§2.8).
    at += 5 + esInfoLength;
  }
  return found;
}

export interface DemuxResult {
  readonly tracks: readonly DemuxedTrack[];
  /** Stream types the PMT declared that this does not understand, for honest reporting. */
  readonly skippedStreamTypes: readonly number[];
}

/**
 * Demultiplex a transport stream.
 *
 * Sequential and single-pass: packets are read in order, PES packets are assembled per
 * PID, and each completed PES packet becomes samples immediately. Nothing is held
 * beyond the current PES packet per track plus the samples themselves.
 */
export function demuxMpegTs(bytes: Uint8Array): Result<DemuxResult, StreamAssemblyError> {
  // A stream may begin mid-packet after a byte-range fetch; find the first sync byte.
  let offset = 0;
  while (offset < bytes.byteLength && (bytes[offset] ?? 0) !== SYNC_BYTE) {
    offset += 1;
  }
  if (offset >= bytes.byteLength) {
    return err(fail('These bytes are not a transport stream', 'stream-ts-not-a-stream'));
  }

  let programMapPid: number | undefined;
  const pidKinds: PidKinds = new Map();
  const skipped = new Set<number>();
  const pending = new Map<number, Uint8Array[]>();
  const video: VideoAccumulator = { kind: 'video', sps: [], pps: [], samples: [] };
  const audio: AudioAccumulator = { kind: 'audio', samples: [] };

  /** Flush the PES packet buffered for a PID into samples. */
  const flush = (pid: number): void => {
    const parts = pending.get(pid);
    pending.delete(pid);
    if (parts === undefined || parts.length === 0) {
      return;
    }
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const joined = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      joined.set(part, at);
      at += part.byteLength;
    }
    const packet = parsePes(joined);
    if (packet === undefined) {
      return;
    }
    if (pidKinds.get(pid) === 'video') {
      addVideoSample(video, packet);
    } else if (pidKinds.get(pid) === 'audio') {
      addAudioSamples(audio, packet);
    }
  };

  let packets = 0;
  for (let at = offset; at + TS_PACKET_SIZE <= bytes.byteLength; at += TS_PACKET_SIZE) {
    packets += 1;
    if (packets > TS_MAX_PACKETS) {
      return err(fail('Transport stream is longer than the accepted ceiling', 'stream-ts-too-big'));
    }
    const packet = bytes.subarray(at, at + TS_PACKET_SIZE);
    if ((packet[0] ?? 0) !== SYNC_BYTE) {
      // Lost sync: re-acquire on the next sync byte rather than reading garbage.
      let resync = at + 1;
      while (resync < bytes.byteLength && (bytes[resync] ?? 0) !== SYNC_BYTE) {
        resync += 1;
      }
      at = resync - TS_PACKET_SIZE;
      continue;
    }
    const pid = (((packet[1] ?? 0) & 0x1f) << 8) | (packet[2] ?? 0);
    const start = payloadStart(packet);
    if (start < 0) {
      continue;
    }
    const payload = packet.subarray(start);
    const isPayloadStart = ((packet[1] ?? 0) & 0x40) !== 0;

    if (pid === PAT_PID) {
      if (isPayloadStart && programMapPid === undefined) {
        programMapPid = programMapPidOf(payload);
      }
      continue;
    }
    if (pid === programMapPid) {
      if (isPayloadStart && pidKinds.size === 0) {
        for (const [streamPid, kind] of elementaryPidsOf(payload)) {
          pidKinds.set(streamPid, kind);
        }
        for (const type of unknownStreamTypes(payload)) {
          skipped.add(type);
        }
      }
      continue;
    }
    if (!pidKinds.has(pid)) {
      continue;
    }
    if (isPayloadStart) {
      // A new PES packet begins: whatever was buffered for this PID is complete.
      flush(pid);
      pending.set(pid, [payload]);
      continue;
    }
    const parts = pending.get(pid);
    if (parts !== undefined) {
      parts.push(payload);
    }
  }
  for (const pid of [...pending.keys()]) {
    flush(pid);
  }

  const tracks: DemuxedTrack[] = [];
  if (video.samples.length > 0) {
    const sps = video.sps[0];
    if (sps === undefined || video.pps.length === 0) {
      return err(fail('The video track carries no parameter sets', 'stream-ts-no-parameter-sets'));
    }
    const size = dimensionsFromSps(sps);
    if (size === undefined) {
      return err(fail('The video track declares no usable picture size', 'stream-ts-no-size'));
    }
    tracks.push({
      kind: 'video',
      timescale: TS_CLOCK_HZ,
      config: {
        kind: 'video',
        sps: video.sps,
        pps: video.pps,
        width: size.width,
        height: size.height,
      },
      samples: video.samples,
    });
  }
  if (audio.samples.length > 0 && audio.config !== undefined) {
    tracks.push({
      kind: 'audio',
      timescale: audio.config.sampleRate,
      config: audio.config,
      samples: audio.samples,
    });
  }
  if (tracks.length === 0) {
    // Name what was there instead, so the refusal is informative rather than blank.
    const describe =
      skipped.size === 0
        ? ''
        : ` (found stream types ${[...skipped].map((type) => `0x${type.toString(16)}`).join(', ')})`;
    return err(
      fail(
        `No H.264 or AAC track was found in this transport stream${describe}`,
        'stream-ts-no-tracks',
      ),
    );
  }
  return ok({ tracks, skippedStreamTypes: [...skipped] });
}

/** Stream types in a PMT that this module does not handle. */
function unknownStreamTypes(payload: Uint8Array): readonly number[] {
  const found: number[] = [];
  const pointer = payload[0] ?? 0;
  const section = payload.subarray(1 + pointer);
  const sectionLength = (((section[1] ?? 0) & 0x0f) << 8) | (section[2] ?? 0);
  const programInfoLength = (((section[10] ?? 0) & 0x0f) << 8) | (section[11] ?? 0);
  const end = Math.min(3 + sectionLength - 4, section.byteLength);
  let at = 12 + programInfoLength;
  while (at + 5 <= end) {
    const streamType = section[at] ?? 0;
    const esInfoLength = (((section[at + 3] ?? 0) & 0x0f) << 8) | (section[at + 4] ?? 0);
    if (streamType !== STREAM_TYPE_H264 && streamType !== STREAM_TYPE_AAC_ADTS) {
      found.push(streamType);
    }
    at += 5 + esInfoLength;
  }
  return found;
}
