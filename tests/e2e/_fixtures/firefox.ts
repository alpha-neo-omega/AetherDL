/**
 * E2E harness: install the REAL built extension into a REAL Firefox and drive it
 * (PROJECT_BIBLE.md §16.3, §7.4).
 *
 * Playwright cannot install a WebExtension into Firefox, so this speaks Marionette —
 * Firefox's own built-in automation protocol — over a socket. No dependency is
 * added: the protocol is a length-prefixed JSON frame, and the browser binary is the
 * one Playwright already downloads (or `FIREFOX_BIN`). `Addon:Install` performs the
 * same temporary install `about:debugging` does, so what runs is the shipped
 * `dist/firefox`, unmodified. Not a test file.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { connect, type Socket } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { distDir } from './extension';

/** The gecko id the Firefox manifest declares (build/manifest/targets.ts). */
export const FIREFOX_ADDON_ID = 'aetherdl@aetherdl.app';
/** Pinned so the extension's pages have a predictable moz-extension:// origin. */
const EXTENSION_UUID = 'a1b2c3d4-e5f6-4711-8899-aabbccddeeff';

function resolveFirefoxBinary(): string {
  const fromEnv = process.env['FIREFOX_BIN'];
  if (fromEnv !== undefined && existsSync(fromEnv)) {
    return fromEnv;
  }
  const registry = join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(registry)) {
    for (const entry of readdirSync(registry)) {
      const candidate = join(registry, entry, 'firefox', 'firefox');
      if (entry.startsWith('firefox-') && existsSync(candidate)) {
        return candidate;
      }
    }
  }
  for (const candidate of ['/usr/bin/firefox', '/usr/local/bin/firefox']) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    'No Firefox binary found. Run "npx playwright install firefox" or set FIREFOX_BIN.',
  );
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not reserve a port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

type MarionetteSend = (command: string, params?: Record<string, unknown>) => Promise<unknown>;

function marionetteClient(socket: Socket): MarionetteSend {
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let buffer = Buffer.alloc(0);
  let nextId = 0;

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const colon = buffer.indexOf(0x3a);
      if (colon < 0) {
        return;
      }
      const length = Number(buffer.subarray(0, colon).toString());
      if (buffer.length < colon + 1 + length) {
        return;
      }
      const frame = buffer.subarray(colon + 1, colon + 1 + length).toString();
      buffer = buffer.subarray(colon + 1 + length);
      const message: unknown = JSON.parse(frame);
      if (!Array.isArray(message) || message[0] !== 1) {
        continue; // the handshake frame, or an event we do not consume
      }
      const entry = pending.get(message[1] as number);
      pending.delete(message[1] as number);
      if (message[2] !== null && message[2] !== undefined) {
        entry?.reject(new Error(JSON.stringify(message[2]).slice(0, 400)));
      } else {
        entry?.resolve(message[3]);
      }
    }
  });

  return (command, params = {}) =>
    new Promise((resolve, reject) => {
      nextId += 1;
      pending.set(nextId, { resolve, reject });
      const payload = JSON.stringify([0, nextId, command, params]);
      socket.write(`${Buffer.byteLength(payload)}:${payload}`);
    });
}

async function connectWhenReady(port: number, timeoutMs: number): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const socket = connect(port, '127.0.0.1');
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
      });
    } catch (cause) {
      if (Date.now() >= deadline) {
        throw cause instanceof Error ? cause : new Error(String(cause));
      }
      await new Promise((wait) => setTimeout(wait, 200));
    }
  }
}

export interface InstalledFirefox {
  readonly extensionId: string;
  /** Origin the extension's own pages are served from in this profile. */
  readonly origin: string;
  /** Navigate the current tab. */
  navigate(url: string): Promise<void>;
  /** Open one of the extension's pages (popup.html, settings.html). */
  open(path: string): Promise<void>;
  /** Run a function body in the current page and return its value. */
  script<T>(body: string, args?: readonly unknown[]): Promise<T>;
  /** Run a promise-returning function body and await it. */
  asyncScript<T>(body: string, args?: readonly unknown[]): Promise<T>;
  /** Poll `read` until `accept` is satisfied. */
  until<T>(what: string, read: () => Promise<T>, accept: (value: T) => boolean): Promise<T>;
  close(): Promise<void>;
}

/**
 * Launch Firefox with a fresh profile and install the add-on temporarily. `sourceDir`
 * defaults to `dist/firefox`; the release suite passes an EXTRACTED artifact.
 */
export async function installFirefoxExtension(sourceDir?: string): Promise<InstalledFirefox> {
  const binary = resolveFirefoxBinary();
  const source = sourceDir ?? distDir('firefox');
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'aetherdl-ff-'));
  mkdirSync(join(profile, 'downloads'), { recursive: true });
  const uuids = JSON.stringify({ [FIREFOX_ADDON_ID]: EXTENSION_UUID }).replace(/"/g, '\\"');
  writeFileSync(
    join(profile, 'user.js'),
    [
      `user_pref("marionette.port", ${String(port)});`,
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("browser.startup.homepage", "about:blank");',
      'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
      'user_pref("toolkit.telemetry.enabled", false);',
      'user_pref("extensions.autoDisableScopes", 0);',
      // Downloads land inside the throwaway profile, never in the operator's real
      // Downloads folder, and go away with it.
      'user_pref("browser.download.folderList", 2);',
      `user_pref("browser.download.dir", "${join(profile, 'downloads').split('\\').join('/')}");`,
      'user_pref("browser.download.useDownloadDir", true);',
      'user_pref("browser.download.manager.showWhenStarting", false);',
      // Pin the internal UUID so the extension's pages have a known origin.
      `user_pref("extensions.webextensions.uuids", "${uuids}");`,
    ].join('\n'),
  );

  const process_: ChildProcess = spawn(
    binary,
    ['-headless', '-marionette', '-no-remote', '-profile', profile, 'about:blank'],
    { stdio: 'ignore' },
  );

  const socket = await connectWhenReady(port, 60_000);
  const send = marionetteClient(socket);
  await send('WebDriver:NewSession', { capabilities: {} });
  await send('WebDriver:SetTimeouts', { script: 30_000, pageLoad: 30_000, implicit: 0 });
  const installed = (await send('Addon:Install', { path: source, temporary: true })) as {
    value?: string;
  };
  if (installed.value !== FIREFOX_ADDON_ID) {
    throw new Error(`Firefox installed "${String(installed.value)}" instead of the built add-on`);
  }

  const origin = `moz-extension://${EXTENSION_UUID}`;
  return {
    extensionId: FIREFOX_ADDON_ID,
    origin,
    async navigate(url: string): Promise<void> {
      await send('WebDriver:Navigate', { url });
    },
    async open(path: string): Promise<void> {
      await send('WebDriver:Navigate', { url: `${origin}/${path}` });
    },
    async script<T>(body: string, args: readonly unknown[] = []): Promise<T> {
      const result = (await send('WebDriver:ExecuteScript', { script: body, args })) as {
        value: T;
      };
      return result.value;
    },
    async asyncScript<T>(body: string, args: readonly unknown[] = []): Promise<T> {
      // Marionette hands the resolve callback in as the last argument.
      const script = `const done = arguments[arguments.length - 1];
        (async () => { ${body} })().then((value) => done({ ok: true, value }),
          (error) => done({ ok: false, error: String(error) }));`;
      const result = (await send('WebDriver:ExecuteAsyncScript', { script, args })) as {
        value: { ok: boolean; value: T; error?: string };
      };
      if (!result.value.ok) {
        throw new Error(result.value.error ?? 'async script failed');
      }
      return result.value.value;
    },
    async until<T>(
      what: string,
      read: () => Promise<T>,
      accept: (value: T) => boolean,
    ): Promise<T> {
      const deadline = Date.now() + 20_000;
      let last: T | undefined;
      while (Date.now() < deadline) {
        last = await read();
        if (accept(last)) {
          return last;
        }
        await new Promise((wait) => setTimeout(wait, 200));
      }
      throw new Error(`timed out waiting for ${what}; last value: ${JSON.stringify(last)}`);
    },
    async close(): Promise<void> {
      try {
        await send('WebDriver:DeleteSession', {});
      } catch {
        // The session may already be gone; the process is killed either way.
      }
      socket.end();
      process_.kill('SIGTERM');
      // The profile carries the downloaded fixtures; nothing should outlive the run.
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

/** The ratified request envelope, sent from a real extension page (§8.5). */
export function requestScript(type: string, payload: unknown): string {
  return `const response = await browser.runtime.sendMessage({
      __aetherdl_msg__: true, kind: 'request', type: ${JSON.stringify(type)},
      payload: ${JSON.stringify(payload)}, id: crypto.randomUUID(),
    });
    if (!response || !response.ok) { throw new Error((response && response.error && response.error.message) || 'no handler'); }
    return response.payload;`;
}
