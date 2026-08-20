/**
 * Fragmented-MP4 muxing (PROJECT_BIBLE.md §10.6).
 *
 * Two kinds of test here, and the distinction matters:
 *
 * 1. Structural tests over hand-built boxes, which always run. They pin the box surgery
 *    — which fields are rewritten, which boxes are dropped, that sample data is copied
 *    byte-for-byte.
 * 2. Tests over REAL h264/aac media produced by `ffmpeg`, whose output is then checked
 *    by `ffprobe`. A muxer that only satisfies its author's idea of the format is worth
 *    little; these confirm a real demuxer accepts the file, counts both streams, and
 *    decodes every frame. They are skipped where `ffmpeg` is absent, and the skip is
 *    reported rather than hidden.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isFragmentedMp4,
  muxFragmentedMp4,
  splitFragmentedMp4,
  type Mp4Track,
} from '@core/download/stream/mux';

import {
  box,
  bytesOf as bytes,
  fragment,
  initSegment,
  joinBytes as join8,
  readBoxes,
  sequencesOf,
  trackIdsOf,
} from './_fmp4';

const videoTrack = (): Mp4Track => ({
  init: initSegment(1),
  fragments: [fragment(1, 1, bytes(0xaa, 0xbb)), fragment(1, 2, bytes(0xcc))],
});

const audioTrack = (): Mp4Track => ({
  init: initSegment(1),
  fragments: [fragment(1, 1, bytes(0x11)), fragment(1, 2, bytes(0x22, 0x33))],
});

function muxed(video = videoTrack(), audio = audioTrack()): Uint8Array {
  const result = muxFragmentedMp4({ video, audio });
  expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
  if (!result.ok) {
    throw result.error;
  }
  return join8(...result.value);
}

describe('mux: structure', () => {
  it('emits one init segment carrying both tracks, then the fragments', () => {
    const out = muxed();
    const top = readBoxes(out).map((entry) => entry.type);

    expect(top.slice(0, 2)).toEqual(['ftyp', 'moov']);
    // Four fragments: two per track, each a moof and its mdat.
    expect(top.slice(2)).toEqual(['moof', 'mdat', 'moof', 'mdat', 'moof', 'mdat', 'moof', 'mdat']);
    expect(top.filter((type) => type === 'moov')).toHaveLength(1);
  });

  it('gives the two tracks distinct ids, video first', () => {
    expect(trackIdsOf(muxed())).toEqual([1, 2, 1, 2]);
  });

  it('renumbers fragment sequences across the whole file', () => {
    // Both inputs numbered their fragments 1, 2. A player reads one sequence.
    expect(sequencesOf(muxed())).toEqual([1, 2, 3, 4]);
  });

  it('declares a trex for each track, so a player expects fragments', () => {
    const out = muxed();
    const moov = readBoxes(out).find((entry) => entry.type === 'moov');
    expect(moov).toBeDefined();
    const children = readBoxes(out.subarray(moov!.start + 8, moov!.start + moov!.size));
    const mvex = children.find((entry) => entry.type === 'mvex');
    expect(mvex).toBeDefined();
    const mvexAt = moov!.start + 8 + mvex!.start;
    const trexes = readBoxes(out.subarray(mvexAt + 8, mvexAt + mvex!.size));
    expect(trexes.map((entry) => entry.type)).toEqual(['trex', 'trex']);
  });

  it('carries two traks and one mvhd', () => {
    const out = muxed();
    const moov = readBoxes(out).find((entry) => entry.type === 'moov');
    const children = readBoxes(out.subarray(moov!.start + 8, moov!.start + moov!.size)).map(
      (entry) => entry.type,
    );

    expect(children.filter((type) => type === 'mvhd')).toHaveLength(1);
    expect(children.filter((type) => type === 'trak')).toHaveLength(2);
  });

  it('copies sample data byte for byte', () => {
    const out = muxed();
    const payloads = readBoxes(out)
      .filter((entry) => entry.type === 'mdat')
      .map((entry) => [...out.subarray(entry.start + 8, entry.start + entry.size)]);

    // Interleaved video, audio, video, audio — and not a byte altered.
    expect(payloads).toEqual([[0xaa, 0xbb], [0x11], [0xcc], [0x22, 0x33]]);
  });

  it('refuses a track with no fragments rather than writing half a file', () => {
    const result = muxFragmentedMp4({
      video: { init: initSegment(1), fragments: [] },
      audio: audioTrack(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe('stream-mux-empty');
    expect(result.error.retryable).toBe(false);
  });

  it('refuses input that is not a fragmented MP4', () => {
    const result = muxFragmentedMp4({
      video: { init: bytes(1, 2, 3, 4), fragments: [fragment(1, 1, bytes(0))] },
      audio: audioTrack(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe('stream-mux-not-fragmented');
  });

  it('keeps going when one track has more fragments than the other', () => {
    const video: Mp4Track = {
      init: initSegment(1),
      fragments: [fragment(1, 1, bytes(1)), fragment(1, 2, bytes(2)), fragment(1, 3, bytes(3))],
    };
    const out = muxed(video, { init: initSegment(1), fragments: [fragment(1, 1, bytes(9))] });

    expect(trackIdsOf(out)).toEqual([1, 2, 1, 1]);
  });
});

describe('mux: splitting a fragmented file', () => {
  it('separates the init segment from the fragments', () => {
    const file = join8(initSegment(1), fragment(1, 1, bytes(7)), fragment(1, 2, bytes(8)));
    const track = splitFragmentedMp4(file);

    expect(readBoxes(track.init).map((entry) => entry.type)).toEqual(['ftyp', 'moov']);
    expect(track.fragments).toHaveLength(2);
    expect(readBoxes(track.fragments[0]!).map((entry) => entry.type)).toEqual(['moof', 'mdat']);
  });

  it('drops the boxes whose byte offsets could not survive interleaving', () => {
    const file = join8(
      initSegment(1),
      box('sidx', new Uint8Array(12)),
      box('styp', new Uint8Array(8)),
      fragment(1, 1, bytes(7)),
      box('mfra', new Uint8Array(8)),
    );
    const track = splitFragmentedMp4(file);
    const all = join8(track.init, ...track.fragments);

    expect(readBoxes(all).map((entry) => entry.type)).toEqual(['ftyp', 'moov', 'moof', 'mdat']);
  });

  it('recognises a fragmented MP4, and does not claim anything else is one', () => {
    expect(isFragmentedMp4(initSegment(1))).toBe(true);
    expect(isFragmentedMp4(new Uint8Array([0x47, 0x40, 0x11, 0x10]))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Real media. `ffmpeg` produces it; `ffprobe` judges the result.
// ---------------------------------------------------------------------------

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const FFMPEG = hasFfmpeg();

describe.skipIf(!FFMPEG)('mux: real h264 + aac, judged by ffprobe', () => {
  let dir: string;
  let video: Mp4Track;
  let audio: Mp4Track;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'aetherdl-mux-'));
    const shared = [
      '-movflags',
      '+frag_keyframe+empty_moov+default_base_moof',
      '-frag_duration',
      '1000000',
      '-f',
      'mp4',
    ];
    execFileSync(
      'ffmpeg',
      [
        ...['-v', 'error', '-y'],
        ...['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=4'],
        ...['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'],
        ...shared,
        join(dir, 'video.mp4'),
      ],
      { stdio: 'ignore' },
    );
    execFileSync(
      'ffmpeg',
      [
        ...['-v', 'error', '-y'],
        ...['-f', 'lavfi', '-i', 'sine=frequency=440:duration=4'],
        ...['-c:a', 'aac', '-b:a', '64k'],
        ...shared,
        join(dir, 'audio.mp4'),
      ],
      { stdio: 'ignore' },
    );
    video = splitFragmentedMp4(new Uint8Array(readFileSync(join(dir, 'video.mp4'))));
    audio = splitFragmentedMp4(new Uint8Array(readFileSync(join(dir, 'audio.mp4'))));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function probe(file: string, args: readonly string[]): string {
    return execFileSync('ffprobe', ['-v', 'error', ...args, file], { encoding: 'utf8' }).trim();
  }

  function write(name: string, parts: readonly Uint8Array[]): string {
    const path = join(dir, name);
    writeFileSync(path, Buffer.concat(parts.map((part) => Buffer.from(part))));
    return path;
  }

  it('split real media into an init segment and several fragments', () => {
    expect(video.fragments.length).toBeGreaterThan(1);
    expect(audio.fragments.length).toBeGreaterThan(1);
    expect(isFragmentedMp4(video.init)).toBe(true);
  });

  it('produces a file ffprobe reads as one video and one audio stream', () => {
    const result = muxFragmentedMp4({ video, audio });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const path = write('muxed.mp4', result.value);

    const streams = probe(path, [
      '-show_entries',
      'stream=codec_type,codec_name',
      '-of',
      'csv=p=0',
    ]);
    expect(streams.split('\n').sort()).toEqual(['aac,audio', 'h264,video']);
  });

  it('decodes end to end, with every frame of both tracks intact', () => {
    const result = muxFragmentedMp4({ video, audio });
    if (!result.ok) {
      throw result.error;
    }
    const path = write('decodable.mp4', result.value);

    // A real decode of the whole file. ffmpeg reports trouble on stderr and exits
    // non-zero, so both are checked: silence here means no corrupt frames, no
    // truncated fragments, no bad offsets. This is the assertion that fails if the
    // muxer gets a single `data_offset` wrong.
    const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-'], {
      encoding: 'utf8',
    });
    expect(decode.stderr.trim(), 'ffmpeg reported no decode errors').toBe('');
    expect(decode.status).toBe(0);

    const frames = (stream: 'v' | 'a', file: string): number =>
      Number(
        probe(file, [
          '-select_streams',
          stream,
          '-count_frames',
          '-show_entries',
          'stream=nb_read_frames',
          '-of',
          'csv=p=0',
        ]),
      );

    expect(frames('v', path)).toBe(frames('v', join(dir, 'video.mp4')));
    expect(frames('a', path)).toBe(frames('a', join(dir, 'audio.mp4')));
  });
});

describe.skipIf(!FFMPEG)('mux: the committed browser fixtures, judged by ffprobe', () => {
  const FIXTURES = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../e2e/_fixtures/site/media/split',
  );

  /** The same files the loopback fixture site serves to the real browser. */
  function committedTrack(prefix: string): Mp4Track {
    const init = splitFragmentedMp4(
      new Uint8Array(readFileSync(join(FIXTURES, `${prefix}-init.mp4`))),
    );
    const fragments: Uint8Array[] = [];
    for (let index = 1; ; index += 1) {
      const file = join(FIXTURES, `${prefix}-${String(index)}.m4s`);
      if (!existsSync(file)) {
        break;
      }
      fragments.push(...splitFragmentedMp4(new Uint8Array(readFileSync(file))).fragments);
    }
    return { init: init.init, fragments };
  }

  it('produces a playable file from the very bytes the browser downloads', () => {
    // The Chromium e2e asserts the browser saved exactly this many bytes; this asserts
    // those bytes are a file a real demuxer plays. Together they close the loop.
    const result = muxFragmentedMp4({ video: committedTrack('v'), audio: committedTrack('a') });
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) {
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'aetherdl-fixture-mux-'));
    const path = join(dir, 'joined.mp4');
    try {
      writeFileSync(path, Buffer.concat(result.value.map((part) => Buffer.from(part))));

      const streams = execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'csv=p=0', path],
        { encoding: 'utf8' },
      )
        .trim()
        .split('\n')
        .sort();
      expect(streams).toEqual(['aac,audio', 'h264,video']);

      const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-'], {
        encoding: 'utf8',
      });
      expect(decode.stderr.trim(), 'ffmpeg reported no decode errors').toBe('');
      expect(decode.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(FFMPEG)('mux: real-media validation', () => {
  it('is skipped because ffmpeg is not installed here', () => {
    // Reported rather than silently absent: the structural tests above still ran, but
    // nothing on this machine confirmed a real demuxer accepts the output.
    expect(FFMPEG).toBe(false);
  });
});
