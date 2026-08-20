/**
 * Generate the split-track HLS fixture the browser e2e downloads.
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
}

main();
