/**
 * The release security gate (PROJECT_BIBLE.md §13.10), specifically the part that
 * changed when stream assembly arrived: `fetch` now exists in the shipped payload.
 * The gate must permit it ONLY where assembly needs it, decide that by reachability
 * over the emitted import graph, and still flag a UI surface that can reach it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateManifest } from '../../../build/manifest/generate';
import { CHECKS, runSecurityGate } from '../../../build/scripts/security-gate';

let outDir: string;

function write(relativePath: string, contents: string): void {
  const path = join(outDir, relativePath);
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

/** A built Chromium directory whose bundles are plausible stand-ins. */
function stage(overrides: Readonly<Record<string, string>> = {}): void {
  const files: Record<string, string> = {
    'manifest.json': JSON.stringify(
      generateManifest({ target: 'chrome', mode: 'production', version: '1.0.0' }),
    ),
    'background.js': 'import"./chunks/deliver.js";const b=1;export{b};',
    'offscreen.js': 'import"./chunks/deliver.js";const o=1;export{o};',
    'chunks/deliver.js': 'async function get(u){return await fetch(u);}export{get};',
    'popup.js': 'import"./chunks/ui.js";const p=1;',
    'settings.js': 'import"./chunks/ui.js";const s=1;',
    'chunks/ui.js': 'const render=()=>null;export{render};',
    'content.js': '(function(){const c=1;})();',
    ...overrides,
  };
  for (const [path, contents] of Object.entries(files)) {
    write(path, contents);
  }
}

const egressFindings = (findings: readonly { check: string; detail: string }[]): string[] =>
  findings.filter((finding) => finding.check === CHECKS[4]).map((finding) => finding.detail);

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), 'aetherdl-gate-'));
});

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe('network access confined to stream assembly (§13.10)', () => {
  it('passes when only the assembly surfaces can reach fetch', () => {
    stage();

    expect(egressFindings(runSecurityGate(outDir, 'chrome').findings)).toEqual([]);
  });

  it('fails when a UI surface can reach the code that calls fetch', () => {
    // The one regression that matters: a chunk split that puts the HTTP client
    // behind the popup.
    stage({ 'popup.js': 'import"./chunks/deliver.js";const p=1;' });

    const findings = egressFindings(runSecurityGate(outDir, 'chrome').findings);

    expect(findings.some((detail) => detail.includes('popup.js reaches'))).toBe(true);
  });

  it('fails when fetch appears in a bundle no assembly surface loads', () => {
    stage({ 'orphan.js': 'const x=()=>fetch("https://x.test");' });

    const findings = egressFindings(runSecurityGate(outDir, 'chrome').findings);

    expect(findings.some((detail) => detail.includes('orphan.js'))).toBe(true);
  });

  it('still forbids every other egress API, even in an assembly surface', () => {
    stage({ 'chunks/deliver.js': 'const s=new WebSocket("wss://x.test");export{s};' });

    const findings = egressFindings(runSecurityGate(outDir, 'chrome').findings);

    expect(findings.some((detail) => detail.includes('WebSocket'))).toBe(true);
  });

  it('flags an embedded remote URL wherever it appears', () => {
    stage({ 'chunks/ui.js': 'const home="https://telemetry.example.com/collect";export{home};' });

    const findings = egressFindings(runSecurityGate(outDir, 'chrome').findings);

    expect(findings.some((detail) => detail.includes('telemetry.example.com'))).toBe(true);
  });
});

describe('no host permission granted at install (§13.7)', () => {
  const hostFindings = (findings: readonly { check: string; detail: string }[]): string[] =>
    findings.filter((finding) => finding.check === CHECKS[1]).map((finding) => finding.detail);

  it('accepts the generated manifests for both targets', () => {
    stage();
    expect(hostFindings(runSecurityGate(outDir, 'chrome').findings)).toEqual([]);

    write(
      'manifest.json',
      JSON.stringify(generateManifest({ target: 'firefox', mode: 'production', version: '1.0.0' })),
    );
    expect(hostFindings(runSecurityGate(outDir, 'firefox').findings)).toEqual([]);
  });

  it('rejects a Chromium build that declares host_permissions', () => {
    stage();
    const manifest = generateManifest({ target: 'chrome', mode: 'production', version: '1.0.0' });
    write('manifest.json', JSON.stringify({ ...manifest, host_permissions: ['*://*/*'] }));

    expect(hostFindings(runSecurityGate(outDir, 'chrome').findings)).not.toEqual([]);
  });

  it('rejects a host pattern wider than the approved one', () => {
    stage();
    const manifest = generateManifest({ target: 'chrome', mode: 'production', version: '1.0.0' });
    write(
      'manifest.json',
      JSON.stringify({ ...manifest, optional_host_permissions: ['<all_urls>'] }),
    );

    expect(hostFindings(runSecurityGate(outDir, 'chrome').findings)).not.toEqual([]);
  });
});
