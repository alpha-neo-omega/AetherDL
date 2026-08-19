/**
 * Module: build/scripts (screenshots)
 * Purpose: Capture the store screenshot set from the REAL built extension, so the
 *          Phase 10 release asset inventory holds genuine photographs of the shipped
 *          UI instead of placeholders (PROJECT_BIBLE.md §2.8: the product never shows
 *          what it cannot substantiate; §22.11 Phase 10 store assets).
 * Responsibilities: Load `dist/chrome` unpacked into Chromium exactly as the e2e
 *          e2e harness does, run the SHIPPED
 *          `content.js` against the loopback non-DRM fixture page and carry the report
 *          it actually produced into the background over the ratified message contract
 *          (§8.5 `detection/run`), then write PNGs of the popup and the settings page
 *          into `dist/release/assets/`. What the cards show is therefore what the
 *          product detects, not a description of it.
 * Restrictions: Build tooling only. Builds nothing — it consumes an existing
 *          `dist/chrome` read-only and fails when that directory is absent. It drives
 *          the real surfaces only: no injected markup, no injected CSS, and no
 *          invented metadata, so a field the detection engine did not supply is simply
 *          absent from the card rather than fabricated (§2.8, §4.2,
 *          src/ui/components/media-card.tsx:5-8). Media comes from a loopback fixture
 *          on a pinned port and is never a real or protected service (§6, §16.3), so
 *          photographing the product stays as zero-egress as the product itself (§14),
 *          and repeated runs produce the same image (§8.15 determinism).
 * Public API: STORE_VIEWPORT, DEVICE_SCALE_FACTOR, FIXTURE_PORT, SHOTS, ShotSpec,
 *          CapturedShot, CaptureOptions, captureStoreScreenshots; CLI entry captures
 *          into dist/release/assets and prints each file with its size and dimensions.
 */
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot } from '../vite/aliases';

/** The build this tool photographs unless told otherwise. */
const CONTENT_DIR = resolve(repoRoot, 'dist', 'chrome');

/**
 * What the content script reports, structurally. Declared here rather than imported
 * from `src/`: build tooling depends on nothing outside `build/`
 * (ARCHITECTURE.md §5.1), and this script only carries the value through.
 */
interface ObservedReport {
  readonly pageUrl: string;
  readonly domSignals: readonly Record<string, unknown>[];
  readonly observedUrls: readonly string[];
}

/**
 * The Chrome Web Store screenshot frame. The store accepts 1280x800 or 640x400 and
 * nothing else, so this is the emitted PNG size, not merely a layout hint.
 */
export const STORE_VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * Fixed loopback port for the fixture site. The media host is rendered on a card
 * (src/ui/components/media-card.tsx), so an ephemeral port would put a different
 * string into every release asset.
 */
export const FIXTURE_PORT = 8787;

/**
 * The surfaces render at the pixel density of a HiDPI display, which is what the
 * reviewer and most users see. Each capture then asks for the CSS-pixel frame
 * (`scale: 'css'`), so the file lands on exactly {@link STORE_VIEWPORT} rather than
 * the 2560x1600 image a device-pixel capture would emit and the store would reject.
 */
export const DEVICE_SCALE_FACTOR = 2;

/** One screenshot: which surface, when it is ready, and what to bring into frame. */
export interface ShotSpec {
  /** File name written into the output directory. Stable: assets are referenced. */
  readonly file: string;
  /** Extension page path, e.g. `popup.html`. */
  readonly page: string;
  /** Selector that must be visible before the shutter opens. */
  readonly ready: string;
  /** Scrolled into view first, for a section further down a long page (§11.2). */
  readonly scrollTo?: string;
  /** Seed this tab's detection state first, so the popup shows real media cards. */
  readonly seedDetection?: boolean;
  /**
   * Photograph only this element, at its natural size. The popup is a narrow panel
   * (§11.4), so a full-viewport shot of it is mostly empty canvas; a true-size image
   * of the panel is what a listing composition needs.
   */
  readonly clipTo?: string;
}

/**
 * The set, in the order a store listing presents it: what the extension finds, what
 * the user can change, and where completed transfers are kept (§11.1, §11.2, §11.3).
 * `#adl-history` is the settings History heading (src/ui/settings/app.tsx:334-336) and
 * `.adl-card` is one detected-media card (src/ui/components/media-card.tsx).
 */
export const SHOTS: readonly ShotSpec[] = [
  {
    file: 'screenshot-1-popup-1280x800.png',
    page: 'popup.html',
    ready: '.adl-card',
    seedDetection: true,
  },
  {
    file: 'screenshot-2-settings-1280x800.png',
    page: 'settings.html',
    ready: '#adl-history',
  },
  {
    file: 'screenshot-3-settings-history-1280x800.png',
    page: 'settings.html',
    ready: '#adl-history',
    scrollTo: '#adl-history',
  },
  {
    file: 'screenshot-4-popup-actual-size.png',
    page: 'popup.html',
    ready: '.adl-card',
    seedDetection: true,
    clipTo: '.adl-popup',
  },
];

export interface CapturedShot {
  /** Absolute path of the written PNG. */
  readonly file: string;
  readonly bytes: number;
  /** Emitted pixel dimensions. A clipped shot is its element's size, not the frame. */
  readonly width: number;
  readonly height: number;
}

export interface CaptureOptions {
  /** Unpacked extension to photograph. Defaults to `dist/chrome`. */
  readonly extensionDir?: string;
  /** Directory the PNGs are written to. Defaults to `dist/release/assets`. */
  readonly outDir?: string;
  /** Per-surface readiness budget. */
  readonly timeoutMs?: number;
}

/** The page and media this tool photographs, written to a temporary directory. */
interface LocalFixture {
  readonly origin: string;
  close(): Promise<void>;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
};

/**
 * Serve a page carrying non-DRM sample media over loopback, from files this script
 * writes itself.
 *
 * Owning the fixture keeps release tooling independent of the test suite
 * (ARCHITECTURE.md §5.1: `build/` depends on nothing) and keeps the photographs to
 * local, non-protected content (§6, §16.3). The port is fixed because the media host
 * is rendered on a card, so an ephemeral one would change every asset.
 */
async function startLocalFixture(port: number): Promise<LocalFixture> {
  const root = mkdtempSync(join(tmpdir(), 'aetherdl-shotsite-'));
  mkdirSync(join(root, 'media'), { recursive: true });
  writeFileSync(
    join(root, 'with-media.html'),
    [
      '<!doctype html>',
      '<html lang="en">',
      '  <head><meta charset="utf-8" /><title>AetherDL sample media</title></head>',
      '  <body>',
      '    <h1>Sample media</h1>',
      '    <video src="/media/sample.mp4" width="1280" height="720" controls></video>',
      '    <audio src="/media/sample.mp3" controls></audio>',
      '  </body>',
      '</html>',
      '',
    ].join('\n'),
    'utf8',
  );
  // Small, real files: enough to be fetched and classified, never a real service.
  const mp4Header = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
  writeFileSync(join(root, 'media', 'sample.mp4'), Buffer.concat([mp4Header, Buffer.alloc(1024)]));
  writeFileSync(
    join(root, 'media', 'sample.mp3'),
    Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(413)]),
  );

  const server: Server = createServer((request, response) => {
    const requested = (request.url ?? '/').split('?')[0] ?? '/';
    const path = join(root, requested);
    if (!path.startsWith(root) || !existsSync(path)) {
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
    server.once('error', fail);
    server.listen(port, '127.0.0.1', ready);
  });

  return {
    origin: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((done, fail) => {
        server.close((error) => (error === undefined ? done() : fail(error)));
        rmSync(root, { recursive: true, force: true });
      }),
  };
}

/**
 * Send one request on the extension's ratified message bus from an extension page
 * (§8.5). The envelope shape is the contract in `src/platform/messaging`; it is written
 * out here because build tooling imports nothing from `src/` or `tests/`.
 */
async function request<T>(page: Page, type: string, payload: unknown): Promise<T> {
  return page.evaluate(
    async ({ messageType, messagePayload }) => {
      const response = (await (
        globalThis as unknown as {
          chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
        }
      ).chrome.runtime.sendMessage({
        __aetherdl_msg__: true,
        kind: 'request',
        type: messageType,
        payload: messagePayload,
        id: crypto.randomUUID(),
      })) as { ok?: boolean; payload?: unknown; error?: { message?: string } };
      if (response?.ok !== true) {
        throw new Error(response?.error?.message ?? `no handler answered "${messageType}"`);
      }
      return response.payload as T;
    },
    { messageType: type, messagePayload: payload },
  ) as Promise<T>;
}

/** What the page collects from the content script under test. */
interface ReportWindow {
  __adlReports?: ObservedReport[];
}

/**
 * Run the SHIPPED `content.js` on the fixture page and return the report it produced.
 *
 * This is the same technique the browser e2e suite uses (tests/e2e/chromium.spec.ts):
 * the background may only inject into a page after a real toolbar gesture (§13.7),
 * which automation cannot synthesise, so the bundle is loaded directly and its own
 * output is carried onward. Nothing about the media is authored here — every field on
 * a photographed card came out of the detection engine, fed by the real scanner.
 */
async function observeFixture(
  context: BrowserContext,
  origin: string,
  timeout: number,
): Promise<ObservedReport> {
  const page = await context.newPage();
  try {
    // Installed as SOURCE TEXT, not as a function: this file is run through tsx, whose
    // transform wraps nested functions in a `__name` helper that does not exist in the
    // page, so a serialised closure would throw before it could install anything.
    await page.addInitScript({
      content: `(() => {
        globalThis.__adlReports = [];
        const noop = function () { return undefined; };
        globalThis.chrome = {
          runtime: {
            id: 'aetherdl-screenshot-probe',
            getManifest: function () { return { manifest_version: 3, version: '0.0.0' }; },
            getURL: function (path) { return path; },
            sendMessage: function (message) {
              if (message && message.payload !== undefined) {
                globalThis.__adlReports.push(message.payload);
              }
              return Promise.resolve(undefined);
            },
            onMessage: {
              addListener: noop,
              removeListener: noop,
              hasListener: function () { return false; },
            },
          },
        };
      })();`,
    });
    await page.bringToFront();
    await page.goto(`${origin}/with-media.html`);
    await page.addScriptTag({ path: join(requireBuiltExtension(CONTENT_DIR), 'content.js') });
    // Interval polling, not the default animation-frame polling: this page is not the
    // one being photographed, and a background page gets no frames in headless.
    await page.waitForFunction(
      () => ((globalThis as ReportWindow).__adlReports?.length ?? 0) > 0,
      undefined,
      { timeout, polling: 200 },
    );
    const report = await page.evaluate(() => (globalThis as ReportWindow).__adlReports?.[0]);
    if (report === undefined) {
      throw new Error('the content script reported nothing for the fixture page');
    }
    return report;
  } finally {
    await page.close();
  }
}

/**
 * Resolve the built extension directory, refusing to invent one. The e2e harness
 * enforces the same invariant for the test suite (tests/e2e/_fixtures/extension.ts:16-22);
 * the wording differs only because the remedy is reported to a release operator here.
 */
function requireBuiltExtension(dir: string): string {
  if (!existsSync(join(dir, 'manifest.json'))) {
    throw new Error(
      `${relative(repoRoot, dir).split('\\').join('/')}/manifest.json is missing — ` +
        'run "npm run build" first',
    );
  }
  return dir;
}

/**
 * Photograph every surface in {@link SHOTS} from the built extension.
 *
 * The launch is written out here rather than borrowed from `loadChromiumExtension()`
 * for one reason: a capture needs a fixed viewport and device scale factor, and those
 * are context-creation options the fixture does not expose. Everything else is
 * written out — the fixture site and the request envelope — because build tooling
 * depends on nothing outside `build/` (ARCHITECTURE.md §5.1); the envelope is the
 * ratified shape from `src/platform/messaging` (§8.5).
 */
export async function captureStoreScreenshots(
  options: CaptureOptions = {},
): Promise<readonly CapturedShot[]> {
  const extensionDir = requireBuiltExtension(options.extensionDir ?? CONTENT_DIR);
  const outDir = options.outDir ?? resolve(repoRoot, 'dist', 'release', 'assets');
  const timeout = options.timeoutMs ?? 15_000;
  mkdirSync(outDir, { recursive: true });

  const site = await startLocalFixture(FIXTURE_PORT);
  const profile = mkdtempSync(join(tmpdir(), 'aetherdl-screenshots-'));

  // The full Chromium channel is required: the headless shell does not load
  // extensions (tests/e2e/_fixtures/extension.ts:34-47).
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { ...STORE_VIEWPORT },
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });

  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker', { timeout: 30_000 }));
    const extensionId = new URL(worker.url()).host;
    // The report the shipped content script produced from the fixture page.
    const report = await observeFixture(context, site.origin, timeout);

    const captured: CapturedShot[] = [];
    for (const shot of SHOTS) {
      const page = await context.newPage();
      try {
        // The default theme follows the OS (src/core/settings/index.ts:19), so pin the
        // preference: a release asset must not change appearance with the build machine.
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto(`chrome-extension://${extensionId}/${shot.page}`);
        // `detection/run` attributes its report to the ACTIVE tab
        // (src/runtime/background/runtime.ts:238-247), so the surface being
        // photographed has to be the front tab before anything is sent.
        await page.bringToFront();

        if (shot.seedDetection === true) {
          const items = await request<readonly unknown[]>(page, 'detection/run', report);
          if (items.length === 0) {
            throw new Error('detection found no media in the fixture report');
          }
          // Re-open the surface so it renders from the background's state, exactly
          // as it does when a user opens the popup on a page with media (§8.5 rule 6).
          await page.reload();
        }

        await page.waitForSelector(shot.ready, { state: 'visible', timeout });
        if (shot.scrollTo !== undefined) {
          await page.locator(shot.scrollTo).scrollIntoViewIfNeeded({ timeout });
        }

        const file = resolve(outDir, shot.file);
        if (shot.clipTo === undefined) {
          await page.screenshot({ path: file, scale: 'css', animations: 'disabled' });
        } else {
          await page
            .locator(shot.clipTo)
            .screenshot({ path: file, scale: 'css', animations: 'disabled' });
        }
        // Read the size back out of the PNG's IHDR chunk rather than assuming the
        // frame: a clipped shot is the element's size (shot 4 is the popup panel).
        const png = readFileSync(file);
        captured.push({
          file,
          bytes: png.length,
          width: png.readUInt32BE(16),
          height: png.readUInt32BE(20),
        });
      } catch (error: unknown) {
        throw new Error(`${shot.file}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await page.close();
      }
    }
    return captured;
  } finally {
    await context.close();
    await site.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry);
}

async function main(): Promise<void> {
  const captured = await captureStoreScreenshots();
  for (const shot of captured) {
    const path = relative(repoRoot, shot.file).split('\\').join('/');
    console.log(
      `[screenshots] ${path} — ${String(shot.width)}x${String(shot.height)}, ` +
        `${String(shot.bytes)} bytes`,
    );
  }
  const storeSized = captured.filter(
    (shot) => shot.width === STORE_VIEWPORT.width && shot.height === STORE_VIEWPORT.height,
  ).length;
  console.log(
    `[screenshots] ${String(captured.length)} file(s) captured from dist/chrome; ` +
      `${String(storeSized)} at the ${String(STORE_VIEWPORT.width)}x` +
      `${String(STORE_VIEWPORT.height)} store frame, the rest at their element size`,
  );
}

if (isMain()) {
  main().catch((error: unknown) => {
    console.error('[screenshots] failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
