/**
 * Performance: the shipped bundle-size budgets (PROJECT_BIBLE.md §12.1, §16.4).
 *
 * The build enforces these against the real `dist/<target>` on every run — this
 * suite proves the measurement itself is right, so a surface can never slip past
 * the budget because the calculator under-counted what the browser loads.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatPayloadReport,
  measureSurfacePayload,
  measureSurfaces,
  SURFACES,
  type SurfaceSpec,
} from '../../build/scripts/validate';

const KB = 1024;

let outDir: string;

function write(relativePath: string, contents: string): void {
  const path = join(outDir, relativePath);
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

function gz(...contents: readonly string[]): number {
  return contents.reduce((total, text) => total + gzipSync(Buffer.from(text, 'utf8')).length, 0);
}

/** A surface with no HTML shell (a worker or content script). */
const bare = (over: Partial<SurfaceSpec> = {}): SurfaceSpec => ({
  surface: 'popup',
  entry: 'popup.js',
  budgetGz: 200 * KB,
  ...over,
});

/** A surface whose HTML shell links a stylesheet. */
const paged = (over: Partial<SurfaceSpec> = {}): SurfaceSpec => ({
  ...bare(over),
  html: 'popup.html',
});

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), 'aetherdl-payload-'));
});

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe('bundle budgets: the shipped surfaces', () => {
  it('holds every surface to the budget PROJECT_BIBLE.md §12.1 sets', () => {
    const byName = Object.fromEntries(SURFACES.map((entry) => [entry.surface, entry.budgetGz]));
    expect(byName).toEqual({
      background: 150 * KB,
      content: 40 * KB,
      popup: 200 * KB,
      settings: 200 * KB,
    });
  });

  it('measures exactly the four shipped surfaces', () => {
    expect(SURFACES.map((entry) => entry.entry)).toEqual([
      'background.js',
      'content.js',
      'popup.js',
      'settings.js',
    ]);
  });
});

describe('bundle budgets: payload measurement', () => {
  it('counts a self-contained entry as itself', () => {
    const entry = 'console.log(1);';
    write('popup.js', entry);
    write('popup.html', '<html></html>');

    const payload = measureSurfacePayload(outDir, paged());

    expect(payload.files).toEqual(['popup.js']);
    expect(payload.gzipBytes).toBe(gz(entry));
    expect(payload.rawBytes).toBe(entry.length);
    expect(payload.withinBudget).toBe(true);
  });

  it('follows the chunks an entry imports, transitively', () => {
    const entry = 'import{a}from"./chunks/one.js";a();';
    const one = 'import{b}from"./two.js";export const a=b;';
    const two = 'export const b=1;';
    write('popup.js', entry);
    write('chunks/one.js', one);
    write('chunks/two.js', two);

    const payload = measureSurfacePayload(outDir, bare());

    expect(payload.files).toEqual(['chunks/one.js', 'chunks/two.js', 'popup.js']);
    expect(payload.gzipBytes).toBe(gz(entry, one, two));
  });

  it('counts a chunk once even when several files import it', () => {
    const entry = 'import"./chunks/one.js";import"./chunks/two.js";';
    const one = 'import"./shared.js";';
    const two = 'import"./shared.js";';
    const shared = 'export const s=1;';
    write('popup.js', entry);
    write('chunks/one.js', one);
    write('chunks/two.js', two);
    write('chunks/shared.js', shared);

    const payload = measureSurfacePayload(outDir, bare());

    expect(payload.files).toEqual([
      'chunks/one.js',
      'chunks/shared.js',
      'chunks/two.js',
      'popup.js',
    ]);
    expect(payload.gzipBytes).toBe(gz(entry, one, two, shared));
  });

  it('survives a cycle between chunks', () => {
    write('popup.js', 'import"./chunks/one.js";');
    write('chunks/one.js', 'import"./two.js";');
    write('chunks/two.js', 'import"./one.js";');

    const payload = measureSurfacePayload(outDir, bare());

    expect(payload.files).toEqual(['chunks/one.js', 'chunks/two.js', 'popup.js']);
  });

  it('counts the stylesheet the HTML shell links', () => {
    const entry = 'console.log(1);';
    const css = '.a{color:red}';
    write('popup.js', entry);
    write('assets/styles.css', css);
    write('popup.html', '<link rel="stylesheet" href="./assets/styles.css" /><div></div>');

    const payload = measureSurfacePayload(outDir, paged());

    expect(payload.files).toEqual(['assets/styles.css', 'popup.js']);
    expect(payload.gzipBytes).toBe(gz(entry, css));
  });

  it('ignores a specifier that resolves to nothing on disk', () => {
    write('popup.js', 'import"./chunks/missing.js";import"https://cdn.test/x.js";');

    const payload = measureSurfacePayload(outDir, bare());

    expect(payload.files).toEqual(['popup.js']);
  });

  it('reports a surface that exceeds its budget rather than rounding it away', () => {
    write('popup.js', 'x'.repeat(4096));

    const payload = measureSurfacePayload(outDir, paged({ budgetGz: 8 }));

    expect(payload.withinBudget).toBe(false);
    expect(payload.gzipBytes).toBeGreaterThan(8);
  });

  it('treats a payload exactly on the budget as within it', () => {
    const entry = 'console.log(1);';
    write('popup.js', entry);

    const payload = measureSurfacePayload(outDir, bare({ budgetGz: gz(entry) }));

    expect(payload.withinBudget).toBe(true);
  });

  it('measures a missing surface as empty rather than throwing', () => {
    const payload = measureSurfacePayload(outDir, paged());
    expect(payload.files).toEqual([]);
    expect(payload.gzipBytes).toBe(0);
  });

  it('measures every surface of an output directory', () => {
    for (const entry of SURFACES) {
      write(entry.entry, 'console.log(1);');
    }
    const payloads = measureSurfaces(outDir);
    expect(payloads.map((payload) => payload.surface)).toEqual([
      'background',
      'content',
      'popup',
      'settings',
    ]);
    expect(payloads.every((payload) => payload.withinBudget)).toBe(true);
  });

  it('formats a report naming each surface, its size and its budget', () => {
    write('popup.js', 'console.log(1);');
    const report = formatPayloadReport([measureSurfacePayload(outDir, bare())]);
    expect(report).toContain('popup');
    expect(report).toContain('gz');
    expect(report).toContain('200.0kB budget');
    expect(report).toContain('1 file');
  });
});

describe('bundle budgets: code splitting', () => {
  it('keeps the content script self-contained', () => {
    // A content script is injected as a classic script: an ES import would not
    // resolve, and every page load would pay for code the page does not need.
    const content = SURFACES.find((entry) => entry.surface === 'content');
    expect(content).toBeDefined();
    expect(content?.html).toBeUndefined();

    write('content.js', '(function(){})();');
    const payload = measureSurfacePayload(
      outDir,
      bare({ surface: 'content', entry: 'content.js', budgetGz: content?.budgetGz ?? 0 }),
    );
    expect(payload.files).toEqual(['content.js']);
  });
});
