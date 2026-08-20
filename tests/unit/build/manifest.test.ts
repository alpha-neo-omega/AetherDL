/**
 * The generated per-target manifests (PROJECT_BIBLE.md §7.6 one generator, §22.11
 * Phase 10 store packages, §14 privacy).
 *
 * Both targets come from one source (`build/manifest/generate.ts`), so these tests
 * hold that source to two things at once: Firefox carries the metadata AMO requires,
 * and Chromium carries none of it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateManifest } from '../../../build/manifest/generate';
import {
  BASELINE_PERMISSIONS,
  FIREFOX_ADDON_ID,
  STREAM_HOST_PATTERN,
  FIREFOX_DATA_COLLECTION_PERMISSIONS,
  FIREFOX_MIN_VERSION,
} from '../../../build/manifest/targets';
import { validateExtension } from '../../../build/scripts/validate';

/** Arbitrary: the generator must pass through whatever version the build context carries. */
const VERSION = '1.2.3';
const firefox = () => generateManifest({ target: 'firefox', mode: 'production', version: VERSION });
const chrome = () => generateManifest({ target: 'chrome', mode: 'production', version: VERSION });

/** The files `validateExtension` requires to exist before it will pass a directory. */
const REQUIRED = [
  'background.js',
  'content.js',
  'popup.js',
  'settings.js',
  'offscreen.js',
  'popup.html',
  'settings.html',
  'offscreen.html',
  'assets/styles.css',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png',
  '_locales/en/messages.json',
];

let outDir: string;

function write(relativePath: string, contents: string): void {
  const path = join(outDir, relativePath);
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

/** A minimal built directory carrying `manifest`, for the real packaging validator. */
function stageDist(manifest: unknown): void {
  for (const file of REQUIRED) {
    write(file, '/* fixture */');
  }
  write('manifest.json', JSON.stringify(manifest));
}

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), 'aetherdl-manifest-'));
});

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe('Firefox manifest metadata (§22.11)', () => {
  it('declares that no data is collected, exactly', () => {
    const gecko = firefox().browser_specific_settings?.gecko;

    // The ratified disclosure: `none` is Mozilla's value for "collects nothing",
    // which is what §14.1 and §14.3 already guarantee.
    expect(gecko?.data_collection_permissions).toEqual({ required: ['none'] });
    expect(FIREFOX_DATA_COLLECTION_PERMISSIONS).toEqual({ required: ['none'] });
  });

  it('keeps the Firefox metadata that was already there', () => {
    const gecko = firefox().browser_specific_settings?.gecko;

    expect(gecko?.id).toBe(FIREFOX_ADDON_ID);
    expect(gecko?.strict_min_version).toBe(FIREFOX_MIN_VERSION);
    // The disclosure is additive: the add-on id and the minimum version are untouched,
    // so Firefox ESR support (§7.1) is unchanged.
    expect(Object.keys(gecko ?? {}).sort()).toEqual([
      'data_collection_permissions',
      'id',
      'strict_min_version',
    ]);
  });

  it('takes no install-time permission beyond the baseline', () => {
    const manifest = firefox();

    // No `offscreen`: a Firefox event page has the DOM APIs a Chromium service
    // worker lacks, so it assembles in place (§7.4).
    expect(manifest.permissions).toEqual([...BASELINE_PERMISSIONS]);
    expect(manifest.optional_permissions).toEqual(['notifications']);
  });

  it('keeps the stream host pattern optional, never granted at install (§13.7)', () => {
    const manifest = firefox();

    // Measured, not assumed: a Firefox build that declared this pattern under
    // `host_permissions` had it ALREADY GRANTED at install, so it lives in
    // `optional_host_permissions` on both targets instead (see targets.ts).
    expect(manifest.optional_host_permissions).toEqual([STREAM_HOST_PATTERN]);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.permissions).not.toContain(STREAM_HOST_PATTERN);
  });
});

describe('Chromium manifest stays free of Firefox-only metadata (§7.6)', () => {
  it('carries no browser_specific_settings at all', () => {
    expect(chrome().browser_specific_settings).toBeUndefined();
    expect(JSON.stringify(chrome())).not.toContain('data_collection_permissions');
    expect(JSON.stringify(chrome())).not.toContain('gecko');
  });

  it('keeps its own permission set and CSP', () => {
    const manifest = chrome();

    // `offscreen` is Chromium-only and grants no host access: it is how a service
    // worker gets a context that can build a blob URL for an assembled stream (§10.6).
    expect(manifest.permissions).toEqual([...BASELINE_PERMISSIONS, 'offscreen']);
    expect(manifest.optional_permissions).toEqual(['notifications', 'contextMenus']);
    expect(manifest.content_security_policy.extension_pages).toContain("script-src 'self'");
    expect(manifest.content_security_policy.extension_pages).toContain("object-src 'none'");
  });

  it('keeps the stream host pattern optional, never granted at install (§13.7)', () => {
    const manifest = chrome();

    expect(manifest.optional_host_permissions).toEqual([STREAM_HOST_PATTERN]);
    // An MV3 `host_permissions` entry on Chromium IS an install-time grant; there
    // must be none, on any pattern.
    expect(manifest.host_permissions).toBeUndefined();
  });

  it('carries the same version as Firefox — one source, synchronized (§18.7)', () => {
    expect(chrome().version).toBe(VERSION);
    expect(firefox().version).toBe(VERSION);
  });
});

describe('packaging validation enforces the disclosure (§8.15)', () => {
  it('accepts a Firefox build that declares no data collection', () => {
    stageDist(firefox());
    expect(() => validateExtension(outDir, 'firefox')).not.toThrow();
  });

  it('rejects a Firefox build with the disclosure missing', () => {
    const manifest = firefox();
    stageDist({
      ...manifest,
      browser_specific_settings: {
        gecko: { id: FIREFOX_ADDON_ID, strict_min_version: FIREFOX_MIN_VERSION },
      },
    });

    expect(() => validateExtension(outDir, 'firefox')).toThrow(
      /gecko\.data_collection_permissions\.required/,
    );
  });

  it('rejects a Firefox build that claims to collect something', () => {
    const manifest = firefox();
    stageDist({
      ...manifest,
      browser_specific_settings: {
        gecko: {
          id: FIREFOX_ADDON_ID,
          strict_min_version: FIREFOX_MIN_VERSION,
          data_collection_permissions: { required: ['technicalAndInteraction'] },
        },
      },
    });

    // A collecting declaration would contradict §14.1/§14.3, so packaging refuses it.
    expect(() => validateExtension(outDir, 'firefox')).toThrow(/must be \["none"\]/);
  });

  it('rejects a Firefox build whose minimum version drops ESR support', () => {
    const manifest = firefox();
    stageDist({
      ...manifest,
      browser_specific_settings: {
        gecko: {
          id: FIREFOX_ADDON_ID,
          // The obvious way to silence the linter's min-version warnings — and it
          // would quietly drop every Firefox ESR user (§7.1).
          strict_min_version: '140.0',
          data_collection_permissions: { required: ['none'] },
        },
      },
    });

    expect(() => validateExtension(outDir, 'firefox')).toThrow(/strict_min_version must be "115/);
  });

  it('rejects a Chromium build that carries Firefox metadata', () => {
    stageDist({ ...chrome(), browser_specific_settings: firefox().browser_specific_settings });

    expect(() => validateExtension(outDir, 'chrome')).toThrow(/Firefox-only/);
  });

  it('accepts the Chromium build as generated', () => {
    stageDist(chrome());
    expect(() => validateExtension(outDir, 'chrome')).not.toThrow();
  });
});
