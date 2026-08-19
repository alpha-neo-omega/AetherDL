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
};

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
