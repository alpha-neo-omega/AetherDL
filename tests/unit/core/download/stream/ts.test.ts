/**
 * MPEG-TS demultiplexing and fragmented-MP4 writing (PROJECT_BIBLE.md §10.6).
 *
 * Two layers of evidence, deliberately:
 *
 * 1. Structural tests over a transport stream this suite writes itself, so every
 *    branch — PAT, PMT, PES assembly across packets, ADTS framing, parameter sets,
 *    unsupported stream types — is exercised on every machine, with no ffmpeg.
 * 2. Real-media tests, gated on ffmpeg, where a genuine h264 + aac transport stream is
 *    demultiplexed, re-packaged, and handed to ffprobe to judge. Container work is
 *    unforgiving; a test that only asserts what this code believes about the format
 *    proves nothing about whether the file plays.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { describe, expect, it } from 'vitest';

import { demuxMpegTs, demuxPackedAudio, TS_CLOCK_HZ } from '@core/download/stream/ts';
import { writeFragmentedMp4 } from '@core/download/stream/mp4write';
import { muxFragmentedMp4, splitFragmentedMp4 } from '@core/download/stream/mux';
import {
  adaptationOnlyPacket,
  adtsFrame,
  annexB,
  AUDIO_PID,
  bytes,
  HIGH_PROFILE_HEIGHT,
  HIGH_PROFILE_PPS,
  HIGH_PROFILE_SPS,
  HIGH_PROFILE_WIDTH,
  join,
  nal,
  packets,
  patPacket,
  pes,
  pmtPacket,
  REAL_PPS,
  REAL_SPS,
  REAL_SPS_HEIGHT,
  REAL_SPS_WIDTH,
  SCALING_MATRIX_HEIGHT,
  SCALING_MATRIX_SPS,
  SCALING_MATRIX_WIDTH,
  STREAM_TYPE_AAC,
  STREAM_TYPE_AC3,
  STREAM_TYPE_H264,
  TS_PACKET_SIZE,
  VIDEO_PID,
} from './_ts';

function have(tool: string): boolean {
  return spawnSync(tool, ['-version'], { stdio: 'ignore' }).status === 0;
}
const FFMPEG = have('ffmpeg') && have('ffprobe');

const SPS_PPS = annexB(REAL_SPS, REAL_PPS);
/** An IDR access unit: parameter sets, then a keyframe slice. */
const KEYFRAME = join(SPS_PPS, annexB(nal(5, 24)));
/** A non-IDR access unit: one P-slice. */
const DELTA = annexB(nal(1, 16));

/** A transport stream with one video PID and one audio PID. */
function twoTrackStream(): Uint8Array {
  const frame = (index: number): Uint8Array =>
    packets(
      VIDEO_PID,
      pes(index === 0 ? KEYFRAME : DELTA, {
        pts: 90_000 + index * 3000,
        dts: 90_000 + index * 3000,
      }),
      index,
    );
  const audio = (index: number): Uint8Array =>
    packets(
      AUDIO_PID,
      pes(join(adtsFrame(), adtsFrame()), { streamId: 0xc0, pts: 90_000 + index * 4180 }),
      index,
    );
  return join(
    patPacket(),
    pmtPacket([
      { streamType: STREAM_TYPE_H264, pid: VIDEO_PID },
      { streamType: STREAM_TYPE_AAC, pid: AUDIO_PID },
    ]),
    frame(0),
    audio(0),
    frame(1),
    frame(2),
    audio(1),
  );
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  return join(...parts);
}

function write(bytes: Uint8Array, name: string): string {
  const path = joinPath(mkdtempSync(joinPath(tmpdir(), 'aetherdl-ts-')), name);
  writeFileSync(path, bytes);
  return path;
}

describe('core/download/stream MPEG-TS demux', () => {
  it('finds both tracks, their configuration, and their samples', () => {
    const result = demuxMpegTs(twoTrackStream());

    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) {
      return;
    }
    const video = result.value.tracks.find((track) => track.kind === 'video');
    const audio = result.value.tracks.find((track) => track.kind === 'audio');
    expect(video?.samples).toHaveLength(3);
    expect(audio?.samples).toHaveLength(4);
    // 90 kHz for video; the sample rate for audio, so a frame lasts exactly 1024.
    expect(video?.timescale).toBe(TS_CLOCK_HZ);
    expect(audio?.timescale).toBe(44_100);
    expect(audio?.samples[1]?.dts).toBe((audio?.samples[0]?.dts ?? 0) + 1024);
  });

  it('reads the picture size out of the parameter set rather than trusting a manifest', () => {
    const result = demuxMpegTs(twoTrackStream());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const config = result.value.tracks.find((track) => track.kind === 'video')?.config;
    expect(config?.kind).toBe('video');
    if (config?.kind !== 'video') {
      return;
    }
    expect({ width: config.width, height: config.height }).toStrictEqual({
      width: REAL_SPS_WIDTH,
      height: REAL_SPS_HEIGHT,
    });
    expect(config.sps).toHaveLength(1);
    expect(config.pps).toHaveLength(1);
  });

  it('reads the AAC configuration out of the ADTS header', () => {
    const stream = join(
      patPacket(),
      pmtPacket([{ streamType: STREAM_TYPE_AAC, pid: AUDIO_PID }]),
      packets(AUDIO_PID, pes(adtsFrame({ rateIndex: 3, channels: 2 }), { streamId: 0xc0, pts: 0 })),
    );

    const result = demuxMpegTs(stream);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const config = result.value.tracks[0]?.config;
    expect(config?.kind).toBe('audio');
    if (config?.kind !== 'audio') {
      return;
    }
    expect(config.sampleRate).toBe(48_000);
    expect(config.channels).toBe(2);
    // AudioSpecificConfig: 5 bits object type (2 = AAC LC), 4 bits rate index (3),
    // 4 bits channel configuration (2).
    expect([...config.audioSpecificConfig]).toStrictEqual([0x11, 0x90]);
    expect(config.samplesPerFrame).toBe(1024);
  });

  it('marks a keyframe as one, and a delta frame as not one', () => {
    const result = demuxMpegTs(twoTrackStream());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const video = result.value.tracks.find((track) => track.kind === 'video');
    expect(video?.samples.map((sample) => sample.isKeyframe)).toStrictEqual([true, false, false]);
  });

  it('drops parameter sets and access-unit delimiters from the samples', () => {
    // They belong in the sample description, not in the mdat; leaving them in is legal
    // but wasteful, and a player that trusts avcC would read them twice.
    const stream = join(
      patPacket(),
      pmtPacket([{ streamType: STREAM_TYPE_H264, pid: VIDEO_PID }]),
      packets(VIDEO_PID, pes(join(annexB(nal(9, 1)), KEYFRAME), { pts: 0, dts: 0 })),
    );

    const result = demuxMpegTs(stream);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const sample = result.value.tracks[0]?.samples[0];
    // One length-prefixed NAL: the IDR slice, 25 bytes plus its 4-byte length.
    expect(sample?.data.byteLength).toBe(4 + 25);
    expect(sample?.isKeyframe).toBe(true);
  });

  it('assembles a PES packet that spans many transport packets', () => {
    // A 1 KB access unit does not fit in one 188-byte packet; getting this wrong
    // produces samples that are silently truncated.
    const big = annexB(REAL_SPS, REAL_PPS, nal(5, 1024));
    const stream = join(
      patPacket(),
      pmtPacket([{ streamType: STREAM_TYPE_H264, pid: VIDEO_PID }]),
      packets(VIDEO_PID, pes(big, { pts: 0, dts: 0 })),
      // A second PES packet is what tells the demuxer the first one ended.
      packets(VIDEO_PID, pes(DELTA, { pts: 3000, dts: 3000 }), 8),
    );

    const result = demuxMpegTs(stream);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.tracks[0]?.samples[0]?.data.byteLength).toBe(4 + 1025);
  });

  it('recovers when the bytes start mid-packet', () => {
    // A byte-range fetch can begin anywhere; the reader has to find sync itself.
    const stream = twoTrackStream();
    const offset = join(new Uint8Array(37).fill(0x11), stream);

    const result = demuxMpegTs(offset);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.tracks).toHaveLength(2);
  });

  it('reports the stream types it left out rather than pretending they were not there', () => {
    const stream = join(
      patPacket(),
      pmtPacket([
        { streamType: STREAM_TYPE_H264, pid: VIDEO_PID },
        { streamType: STREAM_TYPE_AC3, pid: AUDIO_PID },
      ]),
      packets(VIDEO_PID, pes(KEYFRAME, { pts: 0, dts: 0 })),
    );

    const result = demuxMpegTs(stream);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.skippedStreamTypes).toStrictEqual([STREAM_TYPE_AC3]);
    expect(result.value.tracks.map((track) => track.kind)).toStrictEqual(['video']);
  });

  it('refuses a stream whose only tracks are ones it cannot read, and names them', () => {
    const stream = join(
      patPacket(),
      pmtPacket([{ streamType: STREAM_TYPE_AC3, pid: AUDIO_PID }]),
      packets(AUDIO_PID, pes(new Uint8Array(32), { streamId: 0xbd, pts: 0 })),
    );

    const result = demuxMpegTs(stream);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe('stream-ts-no-tracks');
    expect(result.error.message).toContain('0x81');
  });

  it('refuses bytes that are not a transport stream at all', () => {
    const result = demuxMpegTs(new Uint8Array(512).fill(0x11));
    expect(result.ok).toBe(false);
    expect(result.ok || result.error.code).toBe('stream-ts-not-a-stream');
  });

  it('refuses a video track with no parameter sets, instead of writing a broken avcC', () => {
    const stream = join(
      patPacket(),
      pmtPacket([{ streamType: STREAM_TYPE_H264, pid: VIDEO_PID }]),
      packets(VIDEO_PID, pes(annexB(nal(1, 16)), { pts: 0, dts: 0 })),
    );

    const result = demuxMpegTs(stream);
    expect(result.ok).toBe(false);
    expect(result.ok || result.error.code).toBe('stream-ts-no-parameter-sets');
  });

  it('writes whole packets, so the reader never sees a partial one', () => {
    expect(twoTrackStream().byteLength % TS_PACKET_SIZE).toBe(0);
  });
});

describe('core/download/stream fragmented-MP4 writing', () => {
  const remux = (kind: 'video' | 'audio'): ReturnType<typeof writeFragmentedMp4> => {
    const demuxed = demuxMpegTs(twoTrackStream());
    if (!demuxed.ok) {
      throw demuxed.error;
    }
    const track = demuxed.value.tracks.find((candidate) => candidate.kind === kind);
    if (track === undefined) {
      throw new Error(`no ${kind} track`);
    }
    return writeFragmentedMp4(track, { trackId: 1 });
  };

  it('writes an initialisation segment and fragments the muxer can read', () => {
    const written = remux('video');
    expect(written.ok, written.ok ? '' : written.error.message).toBe(true);
    if (!written.ok) {
      return;
    }
    // Round-trip through the splitter the muxer uses: what was written must be
    // recognisable as ftyp/moov plus moof/mdat pairs.
    const split = splitFragmentedMp4(join(written.value.init, ...written.value.fragments));
    expect(split.init.byteLength).toBe(written.value.init.byteLength);
    expect(split.fragments).toHaveLength(written.value.fragments.length);
  });

  it('starts the track at zero, whatever the transport stream timestamps were', () => {
    const written = remux('video');
    expect(written.ok).toBe(true);
    if (!written.ok) {
      return;
    }
    const fragment = written.value.fragments[0] ?? new Uint8Array();
    const text = [...fragment.subarray(0, 120)].map((byte) => String.fromCharCode(byte)).join('');
    const at = text.indexOf('tfdt');
    expect(at).toBeGreaterThan(0);
    const view = new DataView(fragment.buffer, fragment.byteOffset, fragment.byteLength);
    // version 1: a 64-bit base media decode time follows the version and flags.
    const high = view.getUint32(at + 8);
    const low = view.getUint32(at + 12);
    expect(high * 0x100000000 + low).toBe(0);
  });

  it('refuses a track with no samples rather than writing an empty file', () => {
    const written = writeFragmentedMp4({
      kind: 'audio',
      timescale: 44_100,
      config: {
        kind: 'audio',
        audioSpecificConfig: new Uint8Array([0x12, 0x10]),
        sampleRate: 44_100,
        channels: 2,
        samplesPerFrame: 1024,
      },
      samples: [],
    });
    expect(written.ok).toBe(false);
    expect(written.ok || written.error.code).toBe('stream-mp4-no-samples');
  });
});

describe.skipIf(!FFMPEG)('core/download/stream MPEG-TS remux against real media', () => {
  /** Generate a transport stream the way a real encoder does. */
  function realTransportStream(options: {
    readonly video: boolean;
    readonly audio: boolean;
  }): string {
    const dir = mkdtempSync(joinPath(tmpdir(), 'aetherdl-ts-real-'));
    const path = joinPath(dir, 'source.ts');
    const args = ['-v', 'error', '-y'];
    if (options.video) {
      args.push('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=2');
    }
    if (options.audio) {
      args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=2');
    }
    if (options.video) {
      args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '15');
    }
    if (options.audio) {
      args.push('-c:a', 'aac', '-b:a', '64k');
    }
    args.push('-f', 'mpegts', path);
    const result = spawnSync('ffmpeg', args, { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return path;
  }

  interface Probed {
    readonly codec_name?: string;
    readonly codec_type?: string;
    readonly width?: number;
    readonly height?: number;
    readonly sample_rate?: string;
  }

  function probe(path: string): readonly Probed[] {
    const result = spawnSync(
      'ffprobe',
      [
        ...['-v', 'error'],
        ...['-show_entries', 'stream=codec_name,codec_type,width,height,sample_rate'],
        ...['-of', 'json'],
        path,
      ],
      { encoding: 'utf8' },
    );
    expect(result.stderr.trim()).toBe('');
    return (JSON.parse(result.stdout) as { readonly streams?: readonly Probed[] }).streams ?? [];
  }

  function framesOf(path: string, kind: 'v' | 'a'): number {
    const result = spawnSync(
      'ffprobe',
      [
        ...['-v', 'error', '-select_streams', kind, '-count_frames'],
        ...['-show_entries', 'stream=nb_read_frames'],
        ...['-of', 'json'],
        path,
      ],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(result.stdout) as {
      readonly streams?: readonly { readonly nb_read_frames?: string }[];
    };
    return Number(parsed.streams?.[0]?.nb_read_frames ?? '0');
  }

  function decodeErrors(path: string): string {
    return spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-'], {
      encoding: 'utf8',
    }).stderr.trim();
  }

  /** Remux one kind of track out of a transport stream file. */
  function remuxKind(file: string, kind: 'video' | 'audio'): Uint8Array {
    const demuxed = demuxMpegTs(new Uint8Array(readFileSync(file)));
    expect(demuxed.ok, demuxed.ok ? '' : demuxed.error.message).toBe(true);
    if (!demuxed.ok) {
      throw demuxed.error;
    }
    const track = demuxed.value.tracks.find((candidate) => candidate.kind === kind);
    if (track === undefined) {
      throw new Error(`no ${kind} track in ${file}`);
    }
    const written = writeFragmentedMp4(track, { trackId: 1 });
    expect(written.ok, written.ok ? '' : written.error.message).toBe(true);
    if (!written.ok) {
      throw written.error;
    }
    return concat([written.value.init, ...written.value.fragments]);
  }

  it('re-packages a real h264 track into a file that decodes, frame for frame', () => {
    const source = realTransportStream({ video: true, audio: false });
    const path = write(remuxKind(source, 'video'), 'video.mp4');

    expect(probe(path)).toStrictEqual([
      { codec_name: 'h264', codec_type: 'video', width: 320, height: 240 },
    ]);
    expect(decodeErrors(path)).toBe('');
    // 15 fps for two seconds. A sample lost in demuxing would show up here.
    expect(framesOf(path, 'v')).toBe(30);
  });

  it('re-packages a real aac track into a file that decodes, frame for frame', () => {
    const source = realTransportStream({ video: false, audio: true });
    const path = write(remuxKind(source, 'audio'), 'audio.mp4');

    expect(probe(path)).toStrictEqual([
      { codec_name: 'aac', codec_type: 'audio', sample_rate: '44100' },
    ]);
    expect(decodeErrors(path)).toBe('');
    expect(framesOf(path, 'a')).toBeGreaterThan(80);
  });

  it('joins two MPEG-TS renditions into one file that plays', () => {
    // This is the case 1.3.0 refused: audio in its own transport-stream rendition.
    const videoSource = realTransportStream({ video: true, audio: false });
    const audioSource = realTransportStream({ video: false, audio: true });

    const muxed = muxFragmentedMp4({
      video: splitFragmentedMp4(remuxKind(videoSource, 'video')),
      audio: splitFragmentedMp4(remuxKind(audioSource, 'audio')),
    });
    expect(muxed.ok, muxed.ok ? '' : muxed.error.message).toBe(true);
    if (!muxed.ok) {
      return;
    }
    const path = write(concat(muxed.value), 'joined.mp4');

    expect(
      probe(path)
        .map((stream) => stream.codec_type)
        .sort(),
    ).toStrictEqual(['audio', 'video']);
    expect(decodeErrors(path)).toBe('');
    expect(framesOf(path, 'v')).toBe(30);
    expect(framesOf(path, 'a')).toBeGreaterThan(80);
  });

  it('keeps both tracks of a single transport stream in step', () => {
    // Both tracks share one clock here, so their relative timing must survive exactly.
    const source = realTransportStream({ video: true, audio: true });
    const demuxed = demuxMpegTs(new Uint8Array(readFileSync(source)));
    expect(demuxed.ok).toBe(true);
    if (!demuxed.ok) {
      return;
    }
    const origin = Math.min(
      ...demuxed.value.tracks.map(
        (track) => (track.samples[0]?.dts ?? 0) * (TS_CLOCK_HZ / track.timescale),
      ),
    );
    const written = demuxed.value.tracks.map((track) => {
      const result = writeFragmentedMp4(track, { trackId: 1, originTicks90k: origin });
      if (!result.ok) {
        throw result.error;
      }
      return result.value;
    });
    const video = written[0];
    const audio = written[1];
    if (video === undefined || audio === undefined) {
      throw new Error('expected both tracks');
    }
    const muxed = muxFragmentedMp4({ video, audio });
    expect(muxed.ok).toBe(true);
    if (!muxed.ok) {
      return;
    }
    const path = write(concat(muxed.value), 'both.mp4');

    expect(decodeErrors(path)).toBe('');
    expect(framesOf(path, 'v')).toBe(30);
    expect(framesOf(path, 'a')).toBeGreaterThan(80);
  });
});

describe('core/download/stream packed audio (§10.6)', () => {
  it('reads an ADTS rendition that is not a transport stream at all', () => {
    // HLS "packed audio": an audio-only rendition served as a bare `.aac` file. Read
    // as a transport stream it looks like nothing; this is the shape Apple and others
    // actually serve alternate audio in.
    const bytes = join(adtsFrame(), adtsFrame(), adtsFrame());

    const result = demuxPackedAudio(bytes);

    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) {
      return;
    }
    const track = result.value.tracks[0];
    expect(track?.kind).toBe('audio');
    expect(track?.samples).toHaveLength(3);
    // Timestamps start at zero and advance one AAC frame at a time.
    expect(track?.samples.map((sample) => sample.dts)).toStrictEqual([0, 1024, 2048]);
  });

  it('skips ID3 tags, including ones whose payload looks like an ADTS frame', () => {
    // An ID3 payload is arbitrary bytes: scanning past it for a sync word finds false
    // ones, so the tag is skipped by its declared length instead.
    const payload = join(new Uint8Array([0xff, 0xf1, 0x50, 0x80]), new Uint8Array(20).fill(0x00));
    const id3 = join(
      new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]),
      // Synchsafe size: seven bits per byte.
      new Uint8Array([0x00, 0x00, 0x00, payload.byteLength]),
      payload,
    );

    const result = demuxPackedAudio(join(id3, adtsFrame(), adtsFrame()));

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.tracks[0]?.samples).toHaveLength(2);
  });

  it('refuses bytes with no AAC frames rather than reporting an empty track', () => {
    const result = demuxPackedAudio(new Uint8Array(256).fill(0x11));
    expect(result.ok).toBe(false);
    expect(result.ok || result.error.code).toBe('stream-ts-no-tracks');
  });
});

describe('core/download/stream MPEG-TS demux — the shapes real streams are full of', () => {
  it('reads a high-profile parameter set, cropping included', () => {
    // 718 is not a multiple of 16, so the coded picture is 720 tall and the crop has to
    // be applied. Getting this wrong writes a track header that plays stretched.
    const stream = join(
      patPacket(),
      pmtPacket([{ streamType: STREAM_TYPE_H264, pid: VIDEO_PID }]),
      packets(
        VIDEO_PID,
        pes(join(annexB(HIGH_PROFILE_SPS, HIGH_PROFILE_PPS), annexB(nal(5, 32))), {
          pts: 0,
          dts: 0,
        }),
      ),
    );

    const result = demuxMpegTs(stream);
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) {
      return;
    }
    const config = result.value.tracks[0]?.config;
    if (config?.kind !== 'video') {
      throw new Error('expected a video track');
    }
    expect({ width: config.width, height: config.height }).toStrictEqual({
      width: HIGH_PROFILE_WIDTH,
      height: HIGH_PROFILE_HEIGHT,
    });
  });

  it('ignores packets that carry only an adaptation field', () => {
    // PCR-only packets are everywhere in a real stream; reading one as payload would
    // corrupt the PES packet being assembled.
    const stream = join(
      patPacket(),
      pmtPacket([{ streamType: STREAM_TYPE_H264, pid: VIDEO_PID }]),
      packets(VIDEO_PID, pes(KEYFRAME, { pts: 0, dts: 0 })),
      adaptationOnlyPacket(VIDEO_PID),
      packets(VIDEO_PID, pes(DELTA, { pts: 3000, dts: 3000 }), 4),
    );

    const result = demuxMpegTs(stream);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.tracks[0]?.samples).toHaveLength(2);
  });

  it('reads a PMT that carries descriptors, at the program and stream level', () => {
    // Language tags and registration descriptors are normal; skipping them by the wrong
    // length reads the next entry from the middle of this one.
    const descriptor = new Uint8Array([0x0a, 0x04, 0x65, 0x6e, 0x67, 0x00]);
    const stream = join(
      patPacket(),
      pmtPacket(
        [
          { streamType: STREAM_TYPE_H264, pid: VIDEO_PID },
          { streamType: STREAM_TYPE_AAC, pid: AUDIO_PID },
        ],
        { programInfo: descriptor, streamInfo: descriptor },
      ),
      packets(VIDEO_PID, pes(KEYFRAME, { pts: 0, dts: 0 })),
      packets(AUDIO_PID, pes(adtsFrame(), { streamId: 0xc0, pts: 0 })),
    );

    const result = demuxMpegTs(stream);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.tracks.map((track) => track.kind)).toStrictEqual([
      'video',
      'audio',
    ]);
  });

  it('reads a PES packet whose header carries only a PTS', () => {
    // Audio usually has no DTS at all, and a video frame that is not reordered may not
    // either; the presentation time then stands for both.
    const stream = join(
      patPacket(),
      pmtPacket([{ streamType: STREAM_TYPE_H264, pid: VIDEO_PID }]),
      packets(VIDEO_PID, pes(KEYFRAME, { pts: 450_000 })),
    );

    const result = demuxMpegTs(stream);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const sample = result.value.tracks[0]?.samples[0];
    expect(sample?.pts).toBe(450_000);
    expect(sample?.dts).toBe(450_000);
  });

  it('reads a timestamp past the 32-bit boundary', () => {
    // A PTS is 33 bits: a stream running for more than ~13 hours, or one that simply
    // starts high, overflows anything computed with shifts.
    const large = 5_000_000_000;
    const stream = join(
      patPacket(),
      pmtPacket([{ streamType: STREAM_TYPE_H264, pid: VIDEO_PID }]),
      packets(VIDEO_PID, pes(KEYFRAME, { pts: large, dts: large })),
    );

    const result = demuxMpegTs(stream);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.tracks[0]?.samples[0]?.dts).toBe(large);
  });

  it('drops a sample that carries no timestamp at all', () => {
    // Nothing can be placed on a timeline without one; a stream of them ends as a
    // refusal rather than as a track with invented times.
    const noTimestamps = join(
      bytes(0x00, 0x00, 0x01, 0xe0),
      bytes(0x00, 0x00), // PES packet length: unbounded
      bytes(0x80, 0x00, 0x00), // no PTS, no DTS
      KEYFRAME,
    );
    const stream = join(
      patPacket(),
      pmtPacket([{ streamType: STREAM_TYPE_H264, pid: VIDEO_PID }]),
      packets(VIDEO_PID, noTimestamps),
    );

    const result = demuxMpegTs(stream);
    expect(result.ok).toBe(false);
    expect(result.ok || result.error.code).toBe('stream-ts-no-tracks');
  });

  it('reads ADTS frames whose header carries a CRC', () => {
    // Protection present means a 9-byte header; reading it as 7 puts two bytes of CRC
    // at the front of every audio sample.
    const stream = join(
      patPacket(),
      pmtPacket([{ streamType: STREAM_TYPE_AAC, pid: AUDIO_PID }]),
      packets(
        AUDIO_PID,
        pes(join(adtsFrame({ withCrc: true }), adtsFrame({ withCrc: true })), {
          streamId: 0xc0,
          pts: 0,
        }),
      ),
    );

    const result = demuxMpegTs(stream);
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) {
      return;
    }
    const samples = result.value.tracks[0]?.samples ?? [];
    expect(samples).toHaveLength(2);
    // 16 bytes of payload, with neither header nor CRC included.
    expect(samples[0]?.data.byteLength).toBe(16);
  });

  it('stops at an ADTS frame whose declared length runs past the data', () => {
    const truncated = adtsFrame().subarray(0, 12);
    const stream = join(
      patPacket(),
      pmtPacket([{ streamType: STREAM_TYPE_AAC, pid: AUDIO_PID }]),
      packets(AUDIO_PID, pes(join(adtsFrame(), truncated), { streamId: 0xc0, pts: 0 })),
    );

    const result = demuxMpegTs(stream);
    expect(result.ok).toBe(true);
    // The whole frame is kept; the truncated one is not invented into existence.
    expect(result.ok && result.value.tracks[0]?.samples).toHaveLength(1);
  });

  it('refuses an ADTS stream whose sampling-frequency index is reserved', () => {
    const stream = join(
      patPacket(),
      pmtPacket([{ streamType: STREAM_TYPE_AAC, pid: AUDIO_PID }]),
      packets(AUDIO_PID, pes(adtsFrame({ rateIndex: 15 }), { streamId: 0xc0, pts: 0 })),
    );

    const result = demuxMpegTs(stream);
    expect(result.ok).toBe(false);
    expect(result.ok || result.error.code).toBe('stream-ts-no-tracks');
  });

  it('refuses a truncated parameter set instead of writing a broken avcC', () => {
    const stream = join(
      patPacket(),
      pmtPacket([{ streamType: STREAM_TYPE_H264, pid: VIDEO_PID }]),
      // Two bytes is not an SPS; with a valid PPS present, the specific failure is
      // that no picture size can be read from it.
      packets(
        VIDEO_PID,
        pes(join(annexB(bytes(0x67, 0x42), REAL_PPS), annexB(nal(5, 16))), { pts: 0, dts: 0 }),
      ),
    );

    const result = demuxMpegTs(stream);
    expect(result.ok).toBe(false);
    expect(result.ok || result.error.code).toBe('stream-ts-no-size');
  });

  it('ignores a continuation packet for a PID whose PES packet never started', () => {
    // A byte-range fetch that begins mid-PES produces exactly this: the packets that
    // continue a PES packet whose first packet was never seen.
    const spanning = packets(VIDEO_PID, pes(annexB(nal(5, 900)), { pts: 0, dts: 0 }));
    const continuation = spanning.subarray(TS_PACKET_SIZE);
    expect(continuation.byteLength).toBeGreaterThan(0);
    const stream = join(
      patPacket(),
      pmtPacket([{ streamType: STREAM_TYPE_H264, pid: VIDEO_PID }]),
      continuation,
      packets(VIDEO_PID, pes(KEYFRAME, { pts: 3000, dts: 3000 }), 6),
    );

    const result = demuxMpegTs(stream);
    // The orphaned continuation contributes nothing; the complete packet still reads.
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.tracks[0]?.samples).toHaveLength(1);
  });

  it('reads a parameter set from an encode with custom quantisation matrices', () => {
    const stream = join(
      patPacket(),
      pmtPacket([{ streamType: STREAM_TYPE_H264, pid: VIDEO_PID }]),
      packets(
        VIDEO_PID,
        pes(join(annexB(SCALING_MATRIX_SPS, REAL_PPS), annexB(nal(5, 24))), { pts: 0, dts: 0 }),
      ),
    );

    const result = demuxMpegTs(stream);
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) {
      return;
    }
    const config = result.value.tracks[0]?.config;
    if (config?.kind !== 'video') {
      throw new Error('expected a video track');
    }
    // A wrongly skipped scaling list yields a plausible wrong number, not an error.
    expect({ width: config.width, height: config.height }).toStrictEqual({
      width: SCALING_MATRIX_WIDTH,
      height: SCALING_MATRIX_HEIGHT,
    });
  });

  it('ignores a payload on a media PID that is not a PES packet at all', () => {
    const stream = join(
      patPacket(),
      pmtPacket([{ streamType: STREAM_TYPE_H264, pid: VIDEO_PID }]),
      // Right PID, wrong contents: no start code. A hostile or broken server can send
      // this, and it must not be read as a sample (§10.9, §13.8).
      packets(VIDEO_PID, new Uint8Array(200).fill(0x5a)),
      packets(VIDEO_PID, pes(KEYFRAME, { pts: 0, dts: 0 }), 4),
    );

    const result = demuxMpegTs(stream);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.tracks[0]?.samples).toHaveLength(1);
  });

  it('ignores a PES packet too short to carry a header', () => {
    const stream = join(
      patPacket(),
      pmtPacket([{ streamType: STREAM_TYPE_H264, pid: VIDEO_PID }]),
      packets(VIDEO_PID, bytes(0x00, 0x00, 0x01, 0xe0, 0x00, 0x02)),
      packets(VIDEO_PID, pes(KEYFRAME, { pts: 3000, dts: 3000 }), 4),
    );

    const result = demuxMpegTs(stream);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.tracks[0]?.samples).toHaveLength(1);
  });

  it('ignores a PES packet whose declared header runs past its own data', () => {
    const stream = join(
      patPacket(),
      pmtPacket([{ streamType: STREAM_TYPE_H264, pid: VIDEO_PID }]),
      packets(
        VIDEO_PID,
        // headerLength = 240, with nothing like that much data behind it.
        join(bytes(0x00, 0x00, 0x01, 0xe0, 0x00, 0x00, 0x80, 0x80, 0xf0), new Uint8Array(16)),
      ),
      packets(VIDEO_PID, pes(KEYFRAME, { pts: 3000, dts: 3000 }), 4),
    );

    const result = demuxMpegTs(stream);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.tracks[0]?.samples).toHaveLength(1);
  });

  it('skips a PID the PMT never declared', () => {
    const stream = join(
      patPacket(),
      pmtPacket([{ streamType: STREAM_TYPE_H264, pid: VIDEO_PID }]),
      packets(0x1ff, pes(new Uint8Array(64).fill(0x55), { streamId: 0xbd, pts: 0 })),
      packets(VIDEO_PID, pes(KEYFRAME, { pts: 0, dts: 0 })),
    );

    const result = demuxMpegTs(stream);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.tracks).toHaveLength(1);
  });
});
