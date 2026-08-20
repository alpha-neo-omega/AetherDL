/**
 * Real-world stream conformance (PROJECT_BIBLE.md §16.9).
 *
 * Every other test in this repository feeds the parsers and the muxer either
 * hand-written bytes or media this project generated with ffmpeg. That leaves one
 * honest gap, stated in the 1.3.0 release notes: no real packager's output had ever
 * been through them. This suite closes it by pointing the SHIPPED code at streams
 * published by Apple, Mux, Akamai and the DASH Industry Forum for exactly this
 * purpose, and having ffprobe judge what comes out.
 *
 * It is deliberately NOT in `npm run ci`: it needs the network, so it can fail for
 * reasons that say nothing about this code. Run `npm run test:live` by hand and record
 * the result in docs/LIVE_STREAM_CHECK.md.
 *
 * What it does NOT do: fetch a whole stream. Each case reads the manifest and a short
 * PREFIX of each track — enough for a player to decode — because the point is whether
 * our parsing, selection and muxing survive contact with a real packager, not whether
 * a CDN can serve a film. No credentials, no cookies, GET only, through the same
 * `HttpClient` the extension ships.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  listStreamRenditions,
  planStream,
  type FetchPlan,
  type PlannedSegment,
} from '@core/download/stream/assemble';
import { muxFragmentedMp4, trackFromSegments, type Mp4Track } from '@core/download/stream/mux';
import { writeFragmentedMp4 } from '@core/download/stream/mp4write';
import { demuxMpegTs, demuxPackedAudio, TS_CLOCK_HZ } from '@core/download/stream/ts';
import { createHttpClient } from '@platform/http/service';

/** Segments fetched per track: an init segment plus enough media to decode. */
const PREFIX_SEGMENTS = 3;
/**
 * A preference to check the ladder with.
 *
 * Not decoration: the highest-bandwidth rendition of the DASH case here is 4K at
 * 15 Mbps, which is the discovery that motivated the quality picker (§10.6).
 */
const CAPPED_PREFERENCE = '1080' as const;
/** A single segment of 4K video is a few megabytes; anything past this is a bug. */
const MAX_SEGMENT_BYTES = 24 * 1024 * 1024;

const http = createHttpClient({ timeoutMs: 60_000, maxBytes: MAX_SEGMENT_BYTES });

function have(tool: string): boolean {
  return spawnSync(tool, ['-version'], { stdio: 'ignore' }).status === 0;
}
const FFPROBE = have('ffprobe');
const FFMPEG = have('ffmpeg');

interface LiveCase {
  readonly id: string;
  /** Who packaged it — the whole point is that it was not us. */
  readonly packager: string;
  readonly url: string;
  /** What the shipped code should decide, before a single segment is fetched. */
  readonly expect: 'muxed' | 'single' | { readonly refusalCode: string };
  readonly note: string;
}

const CASES: readonly LiveCase[] = [
  {
    id: 'apple-fmp4-separate-audio',
    packager: 'Apple (advanced fMP4 example)',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8',
    expect: 'muxed',
    note: 'HLS, fragmented MP4, audio in its own rendition group — the case 1.3.0 added',
  },
  {
    id: 'dash-akamai-bbb',
    packager: 'Akamai / Blender (Big Buck Bunny, DASH-IF hosted)',
    url: 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd',
    expect: 'muxed',
    note: 'DASH, SegmentTemplate with $Number$, video and audio in separate AdaptationSets',
  },
  {
    id: 'apple-ts-muxed',
    packager: 'Apple (bipbop 4x3)',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/bipbop_4x3_variant.m3u8',
    expect: 'single',
    note: 'HLS, MPEG-TS, audio already muxed into each variant',
  },
  {
    id: 'mux-ts-muxed',
    packager: 'Mux (test-streams)',
    url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
    expect: 'single',
    note: 'HLS, MPEG-TS, a second packager for the same shape',
  },
  {
    id: 'apple-ts-separate-audio',
    packager: 'Apple (bipbop 16x9 advanced example)',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8',
    expect: 'single',
    note: 'Its AUDIO group has a URI-less default rendition, so the variants carry their own audio',
  },
  {
    id: 'dash-if-live-sim',
    packager: 'DASH-IF live simulator',
    url: 'https://livesim.dashif.org/livesim/testpic_2s/Manifest.mpd',
    expect: { refusalCode: 'stream-dash-dynamic' },
    note: 'A live manifest has no end; assembly must say so rather than run forever',
  },
];

function segmentsOfTrack(plan: FetchPlan, track: 'video' | 'audio'): readonly PlannedSegment[] {
  if (plan.mode === 'single') {
    return plan.segments;
  }
  return track === 'video' ? plan.video : plan.audio;
}

async function fetchPrefix(segments: readonly PlannedSegment[]): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = [];
  for (const segment of segments.slice(0, PREFIX_SEGMENTS)) {
    const response = await http.get(segment.url, {
      maxBytes: MAX_SEGMENT_BYTES,
      ...(segment.range !== undefined && {
        range: {
          first: segment.range.offset,
          last: segment.range.offset + segment.range.length - 1,
        },
      }),
    });
    parts.push(response.bytes);
  }
  return parts;
}

/**
 * Build one track from a prefix of its segments, whichever container it is in.
 *
 * This is the same decision the assembler makes: fragmented MP4 is used as it arrives,
 * MPEG-TS is demultiplexed and re-packaged (§10.6).
 */
async function trackOf(
  kind: 'video' | 'audio',
  segments: readonly PlannedSegment[],
): Promise<Mp4Track> {
  const parts = await fetchPrefix(segments);
  const url = segments[0]?.url ?? '';
  if (!/\.(ts|m2ts|mts|aac|adts)(\?|$)/i.test(url)) {
    return trackFromSegments(parts);
  }
  const joined = concat(parts);
  const demuxed = /\.(aac|adts)(\?|$)/i.test(url) ? demuxPackedAudio(joined) : demuxMpegTs(joined);
  if (!demuxed.ok) {
    throw new Error(`${demuxed.error.code}: ${demuxed.error.message}`);
  }
  const track = demuxed.value.tracks.find((candidate) => candidate.kind === kind);
  if (track === undefined) {
    throw new Error(`no ${kind} track in the transport stream`);
  }
  const written = writeFragmentedMp4(track, {
    trackId: 1,
    originTicks90k: (track.samples[0]?.dts ?? 0) * (TS_CLOCK_HZ / track.timescale),
  });
  if (!written.ok) {
    throw new Error(`${written.error.code}: ${written.error.message}`);
  }
  return written.value;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

function write(bytes: Uint8Array, name: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'aetherdl-live-')), name);
  writeFileSync(path, bytes);
  return path;
}

interface ProbedStream {
  readonly codec_name?: string;
  readonly codec_type?: string;
}

/**
 * What ffprobe found, as data.
 *
 * JSON rather than CSV on purpose: a CSV row gains a trailing field for a stream that
 * carries side data — AC-3 does — and string-matching those rows made a correct file
 * look like it had no audio. The muxer was fine; the assertion was wrong.
 */
function probeStreams(path: string): readonly ProbedStream[] {
  const probe = spawnSync(
    'ffprobe',
    [
      ...['-v', 'error'],
      ...['-show_entries', 'stream=codec_name,codec_type'],
      ...['-of', 'json'],
      path,
    ],
    { encoding: 'utf8' },
  );
  expect(probe.stderr.trim()).toBe('');
  const parsed = JSON.parse(probe.stdout) as { readonly streams?: readonly ProbedStream[] };
  return parsed.streams ?? [];
}

/** Frames actually decoded from the first stream of a kind. */
function framesDecoded(path: string, kind: 'v' | 'a'): number {
  const probe = spawnSync(
    'ffprobe',
    [
      ...['-v', 'error', '-select_streams', kind, '-count_frames'],
      ...['-show_entries', 'stream=nb_read_frames'],
      ...['-of', 'json'],
      path,
    ],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(probe.stdout) as {
    readonly streams?: readonly { readonly nb_read_frames?: string }[];
  };
  return Number(parsed.streams?.[0]?.nb_read_frames ?? '0');
}

/** Decode every frame and report what the decoder complained about. */
function decodeErrors(path: string): string {
  const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-'], {
    encoding: 'utf8',
  });
  return decode.stderr.trim();
}

describe('real-world streams: what the shipped code decides', () => {
  for (const live of CASES) {
    it(`${live.id} — ${live.note}`, async () => {
      const plan = await planStream({ manifestUrl: live.url, http });

      if (typeof live.expect === 'object') {
        expect(plan.ok, `expected a refusal from ${live.packager}, got a plan`).toBe(false);
        if (!plan.ok) {
          expect(plan.error.code).toBe(live.expect.refusalCode);
        }
        return;
      }

      expect(
        plan.ok,
        `plan failed for ${live.packager}: ${plan.ok ? '' : `${plan.error.code} ${plan.error.message}`}`,
      ).toBe(true);
      if (!plan.ok) {
        return;
      }
      expect(plan.value.mode).toBe(live.expect);
      // A plan that resolves to nothing would make every later assertion vacuous.
      expect(segmentsOfTrack(plan.value, 'video').length).toBeGreaterThan(0);
    });
  }
});

describe('real-world streams: which rendition gets taken', () => {
  it('caps a real 4K ladder at the height the preference names', async () => {
    const url = 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd';
    const listed = await listStreamRenditions({ manifestUrl: url, http });
    expect(listed.ok, listed.ok ? '' : listed.error.message).toBe(true);
    if (!listed.ok) {
      return;
    }
    const heights = listed.value
      .filter((rendition) => rendition.kind === 'video')
      .map((rendition) => rendition.height);
    // This manifest really does offer 2160p at ~15 Mbps, which is what "highest"
    // used to take without asking.
    expect(heights).toContain(2160);

    const capped = await planStream({
      manifestUrl: url,
      http,
      selection: { preference: CAPPED_PREFERENCE },
    });
    expect(capped.ok).toBe(true);
    if (!capped.ok || capped.value.mode !== 'muxed') {
      throw new Error('expected a muxed plan');
    }
    // The chosen representation names itself in its segment URLs.
    expect(capped.value.video[0]?.url).toContain('1920x1080');
  });
});

describe.skipIf(!FFPROBE || !FFMPEG)('real-world streams: does the output play', () => {
  const decodable = CASES.filter((live) => live.expect === 'muxed');

  for (const live of decodable) {
    it(`${live.id} — muxes ${live.packager} output into a file that decodes`, async () => {
      const plan = await planStream({ manifestUrl: live.url, http });
      expect(plan.ok).toBe(true);
      if (!plan.ok || plan.value.mode !== 'muxed') {
        throw new Error('expected a muxed plan');
      }

      const video = await trackOf('video', plan.value.video);
      const audio = await trackOf('audio', plan.value.audio);
      expect(video.fragments.length).toBeGreaterThan(0);
      expect(audio.fragments.length).toBeGreaterThan(0);

      const muxed = muxFragmentedMp4({ video, audio });
      expect(muxed.ok, muxed.ok ? '' : `${muxed.error.code}: ${muxed.error.message}`).toBe(true);
      if (!muxed.ok) {
        return;
      }
      const path = write(concat(muxed.value), `${live.id}.mp4`);

      // Two streams, one of each kind — a silent video is the failure this feature
      // exists to prevent, and it would pass a "the file exists" assertion.
      const streams = probeStreams(path);
      expect(streams.map((entry) => entry.codec_type).sort()).toStrictEqual(['audio', 'video']);

      // Every frame of both tracks decodes, with nothing to say — and frames actually
      // came out, because a file with two declared streams and no samples also decodes
      // "cleanly".
      expect(decodeErrors(path)).toBe('');
      expect(framesDecoded(path, 'v')).toBeGreaterThan(0);
      expect(framesDecoded(path, 'a')).toBeGreaterThan(0);
    });
  }
});
