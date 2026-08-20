/**
 * E2E fixture server (PROJECT_BIBLE.md §16.3: "local fixture pages with non-DRM
 * sample media only"). Serves the fixture site over loopback so pages load from an
 * http(s) origin — the origin model content scripts and downloads actually run in.
 * No network access, no external hosts. Not a test file.
 */
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SITE_ROOT = resolve(here, 'site');

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.css': 'text/css',
  '.js': 'text/javascript',
  // The committed split-track HLS fixture (see make-stream-fixtures.ts).
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m4s': 'video/iso.segment',
};

/**
 * A non-encrypted HLS VOD stream, generated rather than stored: three equal segments
 * behind a media playlist reached through a master playlist. Deterministic, so a test
 * can assert the assembled size exactly (§16.3 non-DRM fixtures only).
 */
export const HLS_SEGMENT_BYTES = 4096;
export const HLS_SEGMENT_COUNT = 3;
export const HLS_TOTAL_BYTES = HLS_SEGMENT_BYTES * HLS_SEGMENT_COUNT;

export interface FixtureSite {
  /** Origin the fixture pages are served from, e.g. `http://127.0.0.1:41234`. */
  readonly origin: string;
  close(): Promise<void>;
}

/**
 * Start the fixture site on loopback. The port is ephemeral by default; pass one to
 * pin it, which the screenshot tooling needs — the media host is visible on a media
 * card, so a random port would make every release asset differ (§8.15 determinism).
 */
export async function startFixtureSite(root: string = SITE_ROOT, port = 0): Promise<FixtureSite> {
  const server: Server = createServer((request, response) => {
    const requested = (request.url ?? '/').split('?')[0] ?? '/';

    // A deliberately slow transfer, so queue, pause, resume and cancel behaviour can
    // be observed while a download is genuinely in flight.
    if (requested === '/media/slow.mp4') {
      response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '2048000' });
      let sent = 0;
      const tick = setInterval(() => {
        if (sent >= 2_048_000 || response.writableEnded) {
          clearInterval(tick);
          response.end();
          return;
        }
        sent += 32_768;
        response.write(Buffer.alloc(32_768));
      }, 120);
      request.on('close', () => clearInterval(tick));
      return;
    }
    // The HLS fixture: master playlist, media playlist, and its segments.
    if (requested === '/media/hls/master.m3u8') {
      const body = [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
        'index.m3u8',
        '',
      ].join('\n');
      response.writeHead(200, {
        'content-type': 'application/vnd.apple.mpegurl',
        'content-length': String(Buffer.byteLength(body)),
      });
      response.end(body);
      return;
    }
    if (requested === '/media/hls/index.m3u8') {
      const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-PLAYLIST-TYPE:VOD',
      ];
      for (let index = 1; index <= HLS_SEGMENT_COUNT; index += 1) {
        lines.push('#EXTINF:4.000,', `seg-${String(index)}.ts`);
      }
      lines.push('#EXT-X-ENDLIST', '');
      const body = lines.join('\n');
      response.writeHead(200, {
        'content-type': 'application/vnd.apple.mpegurl',
        'content-length': String(Buffer.byteLength(body)),
      });
      response.end(body);
      return;
    }
    const segment = /^\/media\/hls\/seg-(\d+)\.ts$/.exec(requested);
    if (segment !== null) {
      const index = Number(segment[1]);
      if (index < 1 || index > HLS_SEGMENT_COUNT) {
        response.writeHead(404).end();
        return;
      }
      // Each segment carries its own byte value, so a wrong ORDER is detectable.
      response.writeHead(200, {
        'content-type': 'video/mp2t',
        'content-length': String(HLS_SEGMENT_BYTES),
      });
      response.end(Buffer.alloc(HLS_SEGMENT_BYTES, index));
      return;
    }
    // A master playlist whose audio is a separate MPEG-TS rendition. Joining those
    // would mean demuxing and re-packaging, which this project does not do, so it must
    // be refused rather than saved as a silent video (§10.6). The fragmented-MP4 case
    // IS joined — see `site/media/split/master.m3u8`.
    if (requested === '/media/hls/audio-en.m3u8') {
      const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4'];
      for (let index = 1; index <= HLS_SEGMENT_COUNT; index += 1) {
        lines.push('#EXTINF:4.000,', `seg-${String(index)}.ts`);
      }
      lines.push('#EXT-X-ENDLIST', '');
      const body = lines.join('\n');
      response.writeHead(200, {
        'content-type': 'application/vnd.apple.mpegurl',
        'content-length': String(Buffer.byteLength(body)),
      });
      response.end(body);
      return;
    }
    if (requested === '/media/hls/split-audio.m3u8') {
      const body = [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,URI="audio-en.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="aac"',
        'index.m3u8',
        '',
      ].join('\n');
      response.writeHead(200, {
        'content-type': 'application/vnd.apple.mpegurl',
        'content-length': String(Buffer.byteLength(body)),
      });
      response.end(body);
      return;
    }
    // An encrypted playlist, which must be refused rather than downloaded (§6).
    if (requested === '/media/hls/encrypted.m3u8') {
      const body = [
        '#EXTM3U',
        '#EXT-X-KEY:METHOD=AES-128,URI="/media/hls/key.bin"',
        '#EXTINF:4.000,',
        'seg-1.ts',
        '#EXT-X-ENDLIST',
        '',
      ].join('\n');
      response.writeHead(200, {
        'content-type': 'application/vnd.apple.mpegurl',
        'content-length': String(Buffer.byteLength(body)),
      });
      response.end(body);
      return;
    }
    // A URL that always fails, for the retry case.
    if (requested === '/media/missing.mp4') {
      response.writeHead(404).end();
      return;
    }

    const path = join(root, normalize(decodeURIComponent(requested)));
    if (!path.startsWith(root) || !existsSync(path) || !statSync(path).isFile()) {
      response.writeHead(404).end();
      return;
    }
    const body = readFileSync(path);
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
      'content-length': String(body.byteLength),
    });
    response.end(body);
  });

  await new Promise<void>((ready, fail) => {
    // A pinned port can be busy; surface that as a rejection rather than as an
    // uncaught 'error' event that takes the whole run down.
    server.once('error', fail);
    server.listen(port, '127.0.0.1', ready);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fixture site failed to bind a loopback port');
  }

  return {
    // The literal loopback address, not `localhost`: the server binds IPv4 only, and
    // `localhost` can resolve to ::1 first.
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((done, fail) => {
        server.close((error) => (error === undefined ? done() : fail(error)));
      }),
  };
}
