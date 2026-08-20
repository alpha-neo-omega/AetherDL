/**
 * Generate the split-track HLS fixtures the browser e2e downloads.
 *
 * Run by hand — `npx tsx tests/e2e/_fixtures/make-stream-fixtures.ts` — and the output
 * is committed, so the e2e suite needs no ffmpeg and stays deterministic. Regenerate
 * only when the fixture needs to change, and commit what it writes.
 *
 * The result is a real stream: h264 video in one rendition, aac audio in another, both
 * fragmented MP4, exactly the packaging that used to be refused because the two tracks
 * could not be joined (PROJECT_BIBLE.md §10.6).
 *
 * Not a test file.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, 'site', 'media', 'split');
/** The MPEG-TS flavour of the same idea: audio in its own transport-stream rendition. */
const OUT_TS = join(here, 'site', 'media', 'split-ts');
/** Transport packets are fixed width, so a split has to land on a boundary. */
const TS_PACKET_SIZE = 188;

/** Split a fragmented MP4 into `init.mp4` and `NNN.m4s`, mirroring a real packager. */
function writeTrack(prefix: string, file: string): number {
  const data = readFileSync(file);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const init: Buffer[] = [];
  const fragments: Buffer[] = [];
  let pendingMoof: Buffer | undefined;
  let at = 0;

  while (at + 8 <= data.byteLength) {
    const size = view.getUint32(at);
    const type = data.subarray(at + 4, at + 8).toString('latin1');
    const chunk = data.subarray(at, at + size);
    if (type === 'ftyp' || type === 'moov') {
      init.push(Buffer.from(chunk));
    } else if (type === 'moof') {
      pendingMoof = Buffer.from(chunk);
    } else if (type === 'mdat' && pendingMoof !== undefined) {
      fragments.push(Buffer.concat([pendingMoof, Buffer.from(chunk)]));
      pendingMoof = undefined;
    }
    at += size;
  }

  writeFileSync(join(OUT, `${prefix}-init.mp4`), Buffer.concat(init));
  fragments.forEach((fragment, index) => {
    writeFileSync(join(OUT, `${prefix}-${String(index + 1)}.m4s`), fragment);
  });
  return fragments.length;
}

/**
 * Write one elementary transport stream as a two-segment HLS rendition.
 *
 * Split on a packet boundary rather than by re-encoding: an HLS client concatenates
 * segments before decoding, so the only thing that matters is that no packet is cut in
 * half.
 */
function writeTsRendition(prefix: string, file: string): number {
  const data = readFileSync(file);
  const packets = Math.floor(data.byteLength / TS_PACKET_SIZE);
  const half = Math.floor(packets / 2) * TS_PACKET_SIZE;
  // `.m2ts`, not `.ts`: the same container, but a `.ts` file inside a TypeScript
  // repository is read as source by every tool here. The extension is treated
  // identically by the assembler (§5.1).
  writeFileSync(join(OUT_TS, `${prefix}-1.m2ts`), data.subarray(0, half));
  writeFileSync(join(OUT_TS, `${prefix}-2.m2ts`), data.subarray(half, packets * TS_PACKET_SIZE));

  const playlist = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXTINF:1.000,',
    `${prefix}-1.m2ts`,
    '#EXTINF:1.000,',
    `${prefix}-2.m2ts`,
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
  writeFileSync(join(OUT_TS, `${prefix === 'v' ? 'video' : 'audio'}.m3u8`), playlist);
  return 2;
}

/** The MPEG-TS split-track fixture: real h264 and real aac, in separate renditions. */
function makeTransportStreamFixture(): void {
  rmSync(OUT_TS, { recursive: true, force: true });
  mkdirSync(OUT_TS, { recursive: true });
  const video = join(OUT_TS, 'video.tmp.ts');
  const audio = join(OUT_TS, 'audio.tmp.ts');

  execFileSync('ffmpeg', [
    ...['-v', 'error', '-y'],
    ...['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=2'],
    ...['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '10'],
    ...['-f', 'mpegts'],
    video,
  ]);
  execFileSync('ffmpeg', [
    ...['-v', 'error', '-y'],
    ...['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2'],
    ...['-c:a', 'aac', '-b:a', '48k'],
    ...['-f', 'mpegts'],
    audio,
  ]);

  writeTsRendition('v', video);
  writeTsRendition('a', audio);
  rmSync(video);
  rmSync(audio);

  writeFileSync(
    join(OUT_TS, 'master.m3u8'),
    [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,URI="audio.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=160x120,CODECS="avc1.42c00d,mp4a.40.2",AUDIO="aac"',
      'video.m3u8',
      '',
    ].join('\n'),
  );
  console.log('[fixtures] split-track MPEG-TS: 2 video + 2 audio segments');
}

function main(): void {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const shared = [
    '-movflags',
    '+frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration',
    '1000000',
    '-f',
    'mp4',
  ];
  const video = join(OUT, 'video.tmp.mp4');
  const audio = join(OUT, 'audio.tmp.mp4');

  execFileSync('ffmpeg', [
    ...['-v', 'error', '-y'],
    ...['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=2'],
    ...['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'],
    ...shared,
    video,
  ]);
  execFileSync('ffmpeg', [
    ...['-v', 'error', '-y'],
    ...['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2'],
    ...['-c:a', 'aac', '-b:a', '48k'],
    ...shared,
    audio,
  ]);

  const videoFragments = writeTrack('v', video);
  const audioFragments = writeTrack('a', audio);
  rmSync(video);
  rmSync(audio);

  const media = (prefix: string, count: number): string =>
    [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-TARGETDURATION:1',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      `#EXT-X-MAP:URI="${prefix}-init.mp4"`,
      ...Array.from({ length: count }, (_unused, index) => [
        '#EXTINF:1.000,',
        `${prefix}-${String(index + 1)}.m4s`,
      ]).flat(),
      '#EXT-X-ENDLIST',
      '',
    ].join('\n');

  writeFileSync(join(OUT, 'video.m3u8'), media('v', videoFragments));
  writeFileSync(join(OUT, 'audio.m3u8'), media('a', audioFragments));
  writeFileSync(
    join(OUT, 'master.m3u8'),
    [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,URI="audio.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=160x120,CODECS="avc1.42c00d,mp4a.40.2",AUDIO="aac"',
      'video.m3u8',
      '',
    ].join('\n'),
  );

  console.log(
    `[fixtures] split-track HLS: ${String(videoFragments)} video + ${String(audioFragments)} audio fragments`,
  );

  makeTransportStreamFixture();
}

main();
