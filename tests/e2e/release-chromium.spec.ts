/**
 * Release verification (PROJECT_BIBLE.md §22.11 acceptance: "Packages validate for
 * Chrome Web Store, Edge Add-ons, Firefox AMO, and Chromium-compatible stores").
 *
 * Everything here runs against the PACKAGED artifacts in `dist/release`, not against
 * the build directories they came from: each archive is extracted and then installed
 * or linted exactly as a store would receive it. Chromium installs the extracted
 * Chromium package; Firefox installs the extracted AMO package and is additionally
 * run through Mozilla's own linter.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { extractArchive, verifyArchive } from '../../build/scripts/package';
import { validateExtension } from '../../build/scripts/validate';
import { loadChromiumExtension, REPO_ROOT, sendMessage } from './_fixtures/extension';
import { startFixtureSite } from './_fixtures/server';
import { installFirefoxExtension } from './_fixtures/firefox';

const run = promisify(execFile);
const RELEASE_DIR = resolve(REPO_ROOT, 'dist', 'release');

function artifact(target: 'chrome' | 'firefox'): string {
  const version = (
    JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }
  ).version;
  const path = join(RELEASE_DIR, `aetherdl-${version}-${target}.zip`);
  if (!existsSync(path)) {
    throw new Error(`${path} is missing — run "npm run build && npm run package" first`);
  }
  return path;
}

function extract(target: 'chrome' | 'firefox'): string {
  const dir = mkdtempSync(join(tmpdir(), `aetherdl-release-${target}-`));
  const entries = extractArchive(artifact(target), dir);
  expect(entries).toContain('manifest.json');
  return dir;
}

test.describe('release artifacts', () => {
  test('every artifact is a well-formed, checksummed package', () => {
    const sums = readFileSync(join(RELEASE_DIR, 'SHA256SUMS.txt'), 'utf8').trim().split('\n');
    expect(sums.length).toBeGreaterThanOrEqual(2);

    for (const line of sums) {
      const [digest, name] = line.split(/\s+/);
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      const path = join(RELEASE_DIR, name ?? '');
      // Every stored entry still matches the checksum recorded for it.
      expect(verifyArchive(path).entries).toContain('manifest.json');
    }
  });

  test('an independent ZIP reader accepts both artifacts', async () => {
    // Everything else in this chain unpacks with the project's own reader, which would
    // agree with itself even if the container were malformed. Verify the archives with
    // an implementation nobody here wrote: Python's `zipfile`, falling back to `unzip`.
    const readers = [
      {
        name: 'python3 zipfile',
        file: process.platform === 'win32' ? 'python' : 'python3',
        args: (path: string) => [
          '-c',
          [
            'import sys, zipfile',
            'z = zipfile.ZipFile(sys.argv[1])',
            'bad = z.testzip()',
            'assert bad is None, bad',
            'names = z.namelist()',
            'assert "manifest.json" in names, names',
            'print(len(names))',
          ].join('\n'),
          path,
        ],
      },
      { name: 'unzip', file: 'unzip', args: (path: string) => ['-t', path] },
    ];

    let used: string | undefined;
    let failure: unknown;
    for (const reader of readers) {
      try {
        for (const target of ['chrome', 'firefox'] as const) {
          await run(reader.file, reader.args(artifact(target)));
        }
        used = reader.name;
        break;
      } catch (error) {
        failure ??= error;
      }
    }

    expect(
      used,
      `no independent ZIP reader was available (tried python3 and unzip): ${String(failure)}`,
    ).toBeDefined();
  });

  test('the extracted Chromium package passes packaging validation', () => {
    const dir = extract('chrome');
    // Manifest correctness, CSP, permissions and the §12.1 budgets, on the bytes a
    // store would unpack.
    expect(() => validateExtension(dir, 'chrome')).not.toThrow();

    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
      manifest_version: number;
      version: string;
      browser_specific_settings?: unknown;
    };
    expect(manifest.manifest_version).toBe(3);
    // Firefox-only metadata never reaches a Chromium store package.
    expect(manifest.browser_specific_settings).toBeUndefined();
  });

  test('the extracted Firefox package passes packaging validation and declares no data collection', () => {
    const dir = extract('firefox');
    expect(() => validateExtension(dir, 'firefox')).not.toThrow();

    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
      browser_specific_settings: {
        gecko: { id: string; strict_min_version: string; data_collection_permissions: unknown };
      };
    };
    expect(manifest.browser_specific_settings.gecko.data_collection_permissions).toEqual({
      required: ['none'],
    });
    expect(manifest.browser_specific_settings.gecko.strict_min_version).toBe('115.0');
  });

  test('the extracted Firefox package passes Mozilla’s add-on linter with no errors', async () => {
    const dir = extract('firefox');
    const { stdout } = await run(
      process.execPath,
      [
        join(REPO_ROOT, 'node_modules', 'web-ext', 'bin', 'web-ext.js'),
        'lint',
        '--source-dir',
        dir,
        '--output',
        'json',
        '--no-config-discovery',
      ],
      { cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024 },
    );
    const result = JSON.parse(stdout) as {
      errors: readonly unknown[];
      warnings: readonly { code: string }[];
    };

    expect(result.errors).toEqual([]);
    // The disclosure is present, so AMO no longer reports it missing.
    expect(result.warnings.map((warning) => warning.code)).not.toContain(
      'MISSING_DATA_COLLECTION_PERMISSIONS',
    );
  });

  test('the extracted Chromium package installs and runs in a real browser', async () => {
    const dir = extract('chrome');
    const extension = await loadChromiumExtension(dir);
    try {
      const manifest = await extension.worker.evaluate(() => chrome.runtime.getManifest());
      expect(manifest.manifest_version).toBe(3);
      expect(manifest.permissions).toEqual(['storage', 'downloads', 'activeTab', 'scripting']);

      const popup = await extension.page('popup.html');
      await expect(popup.locator('.adl-toolbar')).toBeVisible();
      // The packaged extension answers on the ratified contract.
      const settings = await sendMessage<{ theme: string }>(popup, { type: 'settings/get' });
      expect(settings.theme).toBe('system');
      await popup.close();
    } finally {
      await extension.close();
    }
  });

  test('the packaged extension reaches no host but the one the user asked for', async () => {
    const dir = extract('chrome');
    const extension = await loadChromiumExtension(dir);
    const site = await startFixtureSite();
    const requested: string[] = [];
    try {
      extension.context.on('request', (request) => {
        const url = request.url();
        if (!url.startsWith('chrome-extension://') && !url.startsWith('devtools://')) {
          requested.push(url);
        }
      });

      // Open both surfaces, read settings and history, and run a real download —
      // the whole user-facing surface area, on the packaged build.
      const popup = await extension.page('popup.html');
      await popup.bringToFront();
      const items = await sendMessage<readonly { id: string }[]>(popup, {
        type: 'detection/run',
        payload: {
          pageUrl: `${site.origin}/with-media.html`,
          domSignals: [{ role: 'video', tagName: 'VIDEO', src: `${site.origin}/media/sample.mp4` }],
          observedUrls: [],
        },
      });
      await sendMessage(popup, {
        type: 'download/enqueue',
        payload: { itemIds: [items[0]?.id ?? ''] },
      });
      await sendMessage(popup, { type: 'history/query' });
      const settings = await extension.page('settings.html');
      await settings.waitForTimeout(1500);

      const foreign = requested.filter((url) => !url.startsWith(site.origin));
      // Zero egress, observed on the artifact a store would ship (§14.3): the
      // extension's own pages contact nothing at all.
      expect(foreign).toEqual([]);

      // The transfer the user asked for still happened — and it happened through the
      // browser's own downloads API, which is why it never appears as a request from
      // an extension page (§10.8, §14.3 "the extension's own code makes zero calls").
      const downloads = await extension.worker.evaluate(() =>
        chrome.downloads
          .search({})
          .then((found) => found.map((item) => ({ url: item.url, state: item.state }))),
      );
      expect(downloads.some((item) => item.url === `${site.origin}/media/sample.mp4`)).toBe(true);

      await settings.close();
      await popup.close();
    } finally {
      await site.close();
      await extension.close();
    }
  });

  test('the extracted Firefox package installs and runs in a real Firefox', async () => {
    const dir = extract('firefox');
    const firefox = await installFirefoxExtension(dir);
    try {
      await firefox.open('popup.html');
      const manifest = await firefox.script<{
        manifest_version: number;
        optional_permissions?: string[];
      }>('return browser.runtime.getManifest();');

      expect(manifest.manifest_version).toBe(3);
      expect(manifest.optional_permissions).toEqual(['notifications']);
      const toolbars = await firefox.script<number>(
        'return document.querySelectorAll(".adl-toolbar").length;',
      );
      expect(toolbars).toBe(1);
    } finally {
      await firefox.close();
    }
  });
});
