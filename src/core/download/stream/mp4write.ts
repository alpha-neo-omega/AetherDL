/**
 * Module: core/download/stream (fragmented-MP4 writing)
 * Purpose: Write demultiplexed elementary samples into a fragmented MP4
 *          (PROJECT_BIBLE.md §10.6). The companion to `ts.ts`: that module takes a
 *          transport stream apart, this one puts the pieces into the container the
 *          muxer and the browser can work with.
 * Restrictions: Domain layer — pure. Sample data is copied VERBATIM: this writes box
 *          headers, tables and timestamps around bytes it never inspects, so it does
 *          no decoding, no re-encoding, and cannot decrypt anything (§6, ADR-005).
 * Approach: One `moov` describing the track, then one `moof`+`mdat` per fragment, with
 *          `default-base-is-moof` set so every `trun.data_offset` is relative to its
 *          own fragment — which is what lets the muxer interleave fragments later
 *          without rewriting a single offset.
 * Dependencies: shared/result, core/download/errors, core/download/stream (ts, mux).
 * Public API: FRAGMENT_TARGET_SECONDS, writeFragmentedMp4.
 */
import { err, ok, type Result } from '@shared/result';
import { StreamAssemblyError } from '@core/download/errors';
import type { Mp4Track } from '@core/download/stream/mux';
import type {
  AudioConfig,
  DemuxedSample,
  DemuxedTrack,
  VideoConfig,
} from '@core/download/stream/ts';

/**
 * How much media one fragment covers.
 *
 * Fragments exist so a file can be read progressively and so two tracks can be
 * interleaved; one fragment per track would put every video sample before every audio
 * sample, which is legal and awful. A second is what real packagers use.
 */
export const FRAGMENT_TARGET_SECONDS = 1;

function fail(message: string, code: string): StreamAssemblyError {
  return new StreamAssemblyError(message, {
    code,
    messageKey: 'error.download.stream.tracks',
    retryable: false,
  });
}

function u8(...values: readonly number[]): Uint8Array {
  return new Uint8Array(values);
}

function u16(value: number): Uint8Array {
  return u8((value >>> 8) & 0xff, value & 0xff);
}

function u32(value: number): Uint8Array {
  return u8((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

/** A 64-bit big-endian value, written as two 32-bit halves. */
function u64(value: number): Uint8Array {
  const high = Math.floor(value / 0x100000000);
  return concat([u32(high), u32(value >>> 0)]);
}

/** A signed 32-bit value; composition offsets can be negative in a version-1 `trun`. */
function s32(value: number): Uint8Array {
  return u32(value < 0 ? value + 0x100000000 : value);
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

function box(type: string, ...payload: readonly Uint8Array[]): Uint8Array {
  const body = concat(payload);
  const out = new Uint8Array(8 + body.byteLength);
  out.set(u32(out.byteLength), 0);
  for (let index = 0; index < 4; index += 1) {
    out[4 + index] = type.charCodeAt(index);
  }
  out.set(body, 8);
  return out;
}

/** A full box: version and flags, then the payload. */
function fullBox(
  type: string,
  version: number,
  flags: number,
  ...payload: readonly Uint8Array[]
): Uint8Array {
  return box(
    type,
    u8(version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff),
    ...payload,
  );
}

/** The identity transform, as `tkhd`/`mvhd` store it: 16.16 and 2.30 fixed point. */
const UNITY_MATRIX = concat([
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x40000000),
]);

const VIDEO_TIMESCALE = 90_000;

function ftyp(): Uint8Array {
  const brand = (name: string): Uint8Array => new Uint8Array([...name].map((c) => c.charCodeAt(0)));
  return box(
    'ftyp',
    brand('iso5'),
    u32(0),
    brand('isom'),
    brand('iso5'),
    brand('dash'),
    brand('mp41'),
  );
}

function mvhd(timescale: number, nextTrackId: number): Uint8Array {
  return fullBox(
    'mvhd',
    0,
    0,
    u32(0), // creation time
    u32(0), // modification time
    u32(timescale),
    u32(0), // duration — unknown up front in a fragmented file
    u32(0x00010000), // rate
    u16(0x0100), // volume
    u16(0), // reserved
    u32(0),
    u32(0),
    UNITY_MATRIX,
    concat([u32(0), u32(0), u32(0), u32(0), u32(0), u32(0)]), // pre_defined
    u32(nextTrackId),
  );
}

function tkhd(trackId: number, config: VideoConfig | AudioConfig): Uint8Array {
  const isVideo = config.kind === 'video';
  return fullBox(
    'tkhd',
    0,
    // enabled | in movie | in preview
    0x000007,
    u32(0),
    u32(0),
    u32(trackId),
    u32(0), // reserved
    u32(0), // duration
    u32(0),
    u32(0), // reserved
    u16(0), // layer
    u16(0), // alternate group
    u16(isVideo ? 0 : 0x0100), // volume
    u16(0), // reserved
    UNITY_MATRIX,
    u32(isVideo ? config.width * 0x10000 : 0),
    u32(isVideo ? config.height * 0x10000 : 0),
  );
}

function mdhd(timescale: number): Uint8Array {
  return fullBox(
    'mdhd',
    0,
    0,
    u32(0),
    u32(0),
    u32(timescale),
    u32(0), // duration
    // 'und': the manifest names the language, the bitstream does not, and inventing
    // one would be worse than declaring it undetermined (§2.8).
    u16(0x55c4),
    u16(0),
  );
}

function hdlr(kind: 'video' | 'audio'): Uint8Array {
  const type = kind === 'video' ? 'vide' : 'soun';
  const name = kind === 'video' ? 'VideoHandler' : 'SoundHandler';
  const encoded = new Uint8Array([...name].map((character) => character.charCodeAt(0)));
  return fullBox(
    'hdlr',
    0,
    0,
    u32(0), // pre_defined
    new Uint8Array([...type].map((character) => character.charCodeAt(0))),
    u32(0),
    u32(0),
    u32(0),
    concat([encoded, u8(0)]),
  );
}

function dinf(): Uint8Array {
  // One self-contained data reference: the samples are in this file.
  return box('dinf', box('dref', u32(0), u32(1), fullBox('url ', 0, 1)));
}

/** `avcC`: the decoder configuration record, built from the parameter sets. */
function avcC(config: VideoConfig): Result<Uint8Array, StreamAssemblyError> {
  const sps = config.sps[0];
  const pps = config.pps[0];
  if (sps === undefined || pps === undefined) {
    return err(fail('The video track carries no parameter sets', 'stream-mp4-no-parameter-sets'));
  }
  if (sps.byteLength < 4) {
    return err(fail('The video parameter set is truncated', 'stream-mp4-bad-sps'));
  }
  return ok(
    box(
      'avcC',
      u8(
        1, // configurationVersion
        sps[1] ?? 0, // AVCProfileIndication
        sps[2] ?? 0, // profile_compatibility
        sps[3] ?? 0, // AVCLevelIndication
        0xff, // 6 bits reserved | lengthSizeMinusOne = 3 (4-byte lengths)
        0xe0 | config.sps.length, // 3 bits reserved | numOfSequenceParameterSets
      ),
      ...config.sps.flatMap((set) => [u16(set.byteLength), set]),
      u8(config.pps.length),
      ...config.pps.flatMap((set) => [u16(set.byteLength), set]),
    ),
  );
}

/** A length-prefixed MPEG-4 descriptor, short form (every one here is small). */
function descriptor(tag: number, ...payload: readonly Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([u8(tag, body.byteLength), body]);
}

/** `esds`: the AAC decoder configuration, as an MPEG-4 elementary stream descriptor. */
function esds(config: AudioConfig): Uint8Array {
  const decoderSpecific = descriptor(0x05, config.audioSpecificConfig);
  const decoderConfig = descriptor(
    0x04,
    u8(0x40), // objectTypeIndication: MPEG-4 audio
    u8(0x15), // streamType: audio, upstream 0, reserved 1
    u8(0, 0, 0), // bufferSizeDB — unknown, and not required to decode
    u32(0), // maxBitrate
    u32(0), // avgBitrate
    decoderSpecific,
  );
  const slConfig = descriptor(0x06, u8(0x02));
  return fullBox('esds', 0, 0, descriptor(0x03, u16(1), u8(0), decoderConfig, slConfig));
}

function stsd(config: VideoConfig | AudioConfig): Result<Uint8Array, StreamAssemblyError> {
  if (config.kind === 'video') {
    const record = avcC(config);
    if (!record.ok) {
      return record;
    }
    const compressor = new Uint8Array(32);
    const entry = box(
      'avc1',
      u8(0, 0, 0, 0, 0, 0), // reserved
      u16(1), // data_reference_index
      u16(0), // pre_defined
      u16(0), // reserved
      u32(0),
      u32(0),
      u32(0), // pre_defined
      u16(config.width),
      u16(config.height),
      u32(0x00480000), // horizresolution 72 dpi
      u32(0x00480000), // vertresolution
      u32(0), // reserved
      u16(1), // frame_count
      compressor,
      u16(0x0018), // depth
      u16(0xffff), // pre_defined
      record.value,
    );
    return ok(fullBox('stsd', 0, 0, u32(1), entry));
  }
  const entry = box(
    'mp4a',
    u8(0, 0, 0, 0, 0, 0),
    u16(1), // data_reference_index
    u16(0), // version
    u16(0), // revision
    u32(0), // vendor
    u16(config.channels),
    u16(16), // sample size
    u16(0), // pre_defined
    u16(0), // reserved
    // 16.16 fixed point; a rate past 65535 would not fit, and none of the profiles
    // this accepts go there.
    u32(config.sampleRate * 0x10000),
    esds(config),
  );
  return ok(fullBox('stsd', 0, 0, u32(1), entry));
}

/** An empty sample table: in a fragmented file the samples live in the fragments. */
function emptyStbl(config: VideoConfig | AudioConfig): Result<Uint8Array, StreamAssemblyError> {
  const description = stsd(config);
  if (!description.ok) {
    return description;
  }
  return ok(
    box(
      'stbl',
      description.value,
      fullBox('stts', 0, 0, u32(0)),
      fullBox('stsc', 0, 0, u32(0)),
      fullBox('stsz', 0, 0, u32(0), u32(0)),
      fullBox('stco', 0, 0, u32(0)),
    ),
  );
}

function trak(trackId: number, track: DemuxedTrack): Result<Uint8Array, StreamAssemblyError> {
  const stbl = emptyStbl(track.config);
  if (!stbl.ok) {
    return stbl;
  }
  const media = box(
    'mdia',
    mdhd(track.timescale),
    hdlr(track.kind),
    box(
      'minf',
      track.kind === 'video'
        ? fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0))
        : fullBox('smhd', 0, 0, u16(0), u16(0)),
      dinf(),
      stbl.value,
    ),
  );
  return ok(box('trak', tkhd(trackId, track.config), media));
}

function trex(trackId: number): Uint8Array {
  return fullBox(
    'trex',
    0,
    0,
    u32(trackId),
    u32(1), // default_sample_description_index
    u32(0), // default_sample_duration
    u32(0), // default_sample_size
    u32(0), // default_sample_flags
  );
}

/** Sample flags: whether a decoder may start here, and whether anything depends on it. */
function sampleFlags(sample: DemuxedSample): number {
  // sample_depends_on = 2 (depends on nothing) for a sync sample, 1 otherwise; the
  // non-sync bit is what tells a player where it may seek to.
  return sample.isKeyframe ? 0x02000000 : 0x01010000;
}

interface Fragment {
  readonly samples: readonly DemuxedSample[];
  readonly baseDecodeTime: number;
}

/**
 * Group samples into fragments.
 *
 * Video fragments start on a keyframe wherever the stream offers one, because a
 * fragment that begins mid-GOP cannot be decoded on its own; audio has no such
 * constraint, so it is grouped purely by duration.
 */
function fragmentsOf(track: DemuxedTrack): readonly Fragment[] {
  const target = track.timescale * FRAGMENT_TARGET_SECONDS;
  const fragments: Fragment[] = [];
  let current: DemuxedSample[] = [];
  let startedAt = track.samples[0]?.dts ?? 0;

  for (const sample of track.samples) {
    const wouldBeLongEnough = sample.dts - startedAt >= target;
    const mayStartHere = track.kind === 'audio' || sample.isKeyframe;
    if (current.length > 0 && wouldBeLongEnough && mayStartHere) {
      fragments.push({ samples: current, baseDecodeTime: startedAt });
      current = [];
      startedAt = sample.dts;
    }
    current.push(sample);
  }
  if (current.length > 0) {
    fragments.push({ samples: current, baseDecodeTime: startedAt });
  }
  return fragments;
}

/**
 * Per-sample durations.
 *
 * The last sample has no successor to measure against, so it takes the previous
 * sample's duration — the honest choice available, and the one every packager makes.
 */
function durationsOf(samples: readonly DemuxedSample[], nextDts: number | undefined): number[] {
  const durations: number[] = [];
  for (let index = 0; index < samples.length; index += 1) {
    const current = samples[index];
    const next = samples[index + 1];
    if (current === undefined) {
      continue;
    }
    if (next !== undefined) {
      durations.push(Math.max(0, next.dts - current.dts));
      continue;
    }
    if (nextDts !== undefined) {
      durations.push(Math.max(0, nextDts - current.dts));
      continue;
    }
    durations.push(durations[durations.length - 1] ?? 0);
  }
  return durations;
}

/** One `moof`+`mdat` pair, written together so `data_offset` can be computed exactly. */
function writeFragment(
  trackId: number,
  sequence: number,
  fragment: Fragment,
  nextDts: number | undefined,
): Uint8Array {
  const durations = durationsOf(fragment.samples, nextDts);
  const entries: Uint8Array[] = fragment.samples.map((sample, index) =>
    concat([
      u32(durations[index] ?? 0),
      u32(sample.data.byteLength),
      u32(sampleFlags(sample)),
      s32(sample.pts - sample.dts),
    ]),
  );
  // duration | size | flags | composition offset, per sample, plus a data offset.
  const trunFlags = 0x000f01;
  const build = (dataOffset: number): Uint8Array =>
    box(
      'moof',
      fullBox('mfhd', 0, 0, u32(sequence)),
      box(
        'traf',
        // default-base-is-moof: every offset below is relative to this moof, which is
        // what keeps the fragment valid wherever it ends up in the file.
        fullBox('tfhd', 0, 0x020000, u32(trackId)),
        fullBox('tfdt', 1, 0, u64(fragment.baseDecodeTime)),
        fullBox('trun', 1, trunFlags, u32(fragment.samples.length), s32(dataOffset), ...entries),
      ),
    );
  // The offset depends on the size of the box that carries it, and that size does not
  // depend on the offset's value, so one measuring pass is exact.
  const measured = build(0).byteLength;
  const moof = build(measured + 8);
  const payload = concat(fragment.samples.map((sample) => sample.data));
  return concat([moof, box('mdat', payload)]);
}

/**
 * Write one demultiplexed track as a fragmented MP4 — an initialisation segment plus
 * its fragments, which is exactly what the muxer consumes.
 *
 * Timestamps are shifted so the track starts at zero. Where a caller remuxes two
 * tracks from one transport stream it passes the same `originTicks90k` for both, and
 * their relative timing is preserved exactly; where the two tracks came from separate
 * renditions each starts at its own first sample, so they can differ by up to one
 * frame. That is stated rather than hidden (§2.8).
 */
export function writeFragmentedMp4(
  track: DemuxedTrack,
  options: { readonly trackId?: number; readonly originTicks90k?: number } = {},
): Result<Mp4Track, StreamAssemblyError> {
  if (track.samples.length === 0) {
    return err(fail('A remuxed track has no samples', 'stream-mp4-no-samples'));
  }
  const trackId = options.trackId ?? 1;
  const origin90k =
    options.originTicks90k ?? (track.samples[0]?.dts ?? 0) * (VIDEO_TIMESCALE / track.timescale);
  const origin = Math.round((origin90k * track.timescale) / VIDEO_TIMESCALE);
  const shifted: DemuxedTrack = {
    ...track,
    samples: track.samples.map((sample) => ({
      ...sample,
      dts: sample.dts - origin,
      pts: sample.pts - origin,
    })),
  };

  const header = trak(trackId, shifted);
  if (!header.ok) {
    return header;
  }
  const init = concat([
    ftyp(),
    box('moov', mvhd(VIDEO_TIMESCALE, trackId + 1), header.value, box('mvex', trex(trackId))),
  ]);

  const groups = fragmentsOf(shifted);
  const fragments = groups.map((fragment, index) =>
    writeFragment(trackId, index + 1, fragment, groups[index + 1]?.samples[0]?.dts),
  );
  return ok({ init, fragments });
}
