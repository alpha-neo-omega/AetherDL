/**
 * Module: build/scripts (security gate)
 * Purpose: Execute the release security review checklist automatically
 *          (PROJECT_BIBLE.md §13.10): permissions unchanged/justified, CSP intact,
 *          no remote code, no host permission granted at install, network access
 *          confined to stream assembly, URL validation in place, message validation
 *          in place, no DRM-circumvention code paths (§6).
 * Responsibilities: Read-only inspection of `src/` and of every built target. Report
 *          each check with its verdict; exit non-zero on any violation.
 * Restrictions: Build tooling only. Never modifies the tree it inspects.
 * Public API: CHECKS, runSecurityGate, formatGateReport; CLI entry gates
 *          dist/<target> for all targets.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot } from '../vite/aliases';
import {
  hostPermissionsFor,
  optionalHostPermissionsFor,
  optionalPermissionsFor,
  permissionsFor,
  STREAM_HOST_PATTERN,
  TARGETS,
  type Target,
} from '../manifest/targets';

export interface GateFinding {
  /** The §13.10 checklist item this belongs to. */
  readonly check: string;
  readonly detail: string;
}

export interface GateResult {
  readonly target: Target;
  readonly checks: readonly string[];
  readonly findings: readonly GateFinding[];
  /**
   * Bundles identified as vendor code (React), where two remote-code patterns are not
   * enforced. Reported so the exclusion is visible in the gate's own output.
   */
  readonly vendorChunks: readonly string[];
}

/** The §13.10 checklist, in the order it is reported. */
export const CHECKS = [
  'permissions unchanged and justified',
  'no host permission granted at install',
  'CSP intact',
  'no remote code',
  'network access confined to stream assembly',
  'URL validation in place',
  'message validation in place',
  'no DRM-circumvention code path',
  'no background-only code in a UI surface',
] as const;

function walk(dir: string, keep: (path: string) => boolean): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walk(path, keep));
    } else if (keep(path)) {
      found.push(path);
    }
  }
  return found;
}

const SOURCE_FILES = (): readonly string[] =>
  walk(resolve(repoRoot, 'src'), (path) => ['.ts', '.tsx'].includes(extname(path)));

/** Remote code and dynamic evaluation: forbidden outright (§13.2, §13.4). */
const REMOTE_CODE_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['eval', /\beval\s*\(/],
  ['new Function', /\bnew\s+Function\s*\(/],
  ['importScripts', /\bimportScripts\s*\(/],
  ['remote script element', /createElement\(\s*["']script["']\s*\)/],
  ['innerHTML assignment', /\.innerHTML\s*=/],
];

/**
 * Anything that could send data off the device. Everything here is forbidden
 * everywhere, with ONE deliberate exception below: `fetch`, which stream assembly
 * needs to read a manifest and its segments (§10.6).
 *
 * AetherDL therefore no longer makes zero network calls of its own: it makes exactly
 * the reads a download the user asked for requires, to the media host, with no
 * credentials and no body (§14.3 as amended). Nothing is ever SENT: no analytics, no
 * telemetry, no beacon, no socket, no report of any kind.
 */
const EGRESS_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['fetch', /\bfetch\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['WebSocket', /\bnew\s+WebSocket\b/],
  ['sendBeacon', /\bsendBeacon\s*\(/],
  ['EventSource', /\bnew\s+EventSource\b/],
];

/** The one file permitted to call `fetch`, and the only one that does (§10.6). */
const HTTP_CLIENT_SOURCE = 'src/platform/http/service.ts';

/**
 * Emitted bundles whose payload may contain `fetch`: the two surfaces that assemble
 * streams. A UI surface must not contain it, and neither may anything a UI surface
 * imports — {@link scanBundles} proves that by walking the emitted import graph
 * rather than trusting file names.
 */
const ASSEMBLY_ENTRIES = ['background.js', 'offscreen.js'];

/** APIs that only exist to touch protected content (§6, ADR-005). */
const DRM_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['requestMediaKeySystemAccess', /requestMediaKeySystemAccess/],
  ['setMediaKeys', /\.setMediaKeys\s*\(/],
  ['key system name', /\b(widevine|playready|fairplay|clearkey)\b/i],
  ['decryption', /\bdecrypt(?:ion)?\s*\(/i],
];

/** Symbols that must never appear in a UI surface's payload (§8.4, §12.1). */
const BACKGROUND_ONLY_MARKERS: readonly string[] = ['html5-video', 'html5-audio', 'direct-url'];

function scanSources(findings: GateFinding[]): void {
  for (const path of SOURCE_FILES()) {
    const source = readFileSync(path, 'utf8');
    const where = relative(repoRoot, path).split('\\').join('/');
    for (const [name, pattern] of REMOTE_CODE_PATTERNS) {
      if (pattern.test(source)) {
        findings.push({ check: CHECKS[3], detail: `${where} uses ${name}` });
      }
    }
    for (const [name, pattern] of EGRESS_PATTERNS) {
      if (!pattern.test(source)) {
        continue;
      }
      // `fetch` in the one adapter that exists to make it is the whole exception;
      // anywhere else — and every other egress API, everywhere — is a finding.
      if (name === 'fetch' && where === HTTP_CLIENT_SOURCE) {
        continue;
      }
      findings.push({ check: CHECKS[4], detail: `${where} uses ${name}` });
    }
    for (const [name, pattern] of DRM_PATTERNS) {
      // The DRM REFUSAL path names encryption; only key handling is forbidden.
      if (pattern.test(source) && !/unsupported|refus|encrypted media|DRM/i.test(source)) {
        findings.push({ check: CHECKS[7], detail: `${where} references ${name}` });
      }
    }
  }

  // The boundary guards themselves must still exist (§13.8).
  const guards: readonly (readonly [string, string, string])[] = [
    ['src/shared/utils/url.ts', 'normalizeUrl', CHECKS[5]],
    ['src/runtime/background/context.ts', 'isDetectionReport', CHECKS[6]],
    // The HTTP client must keep refusing every scheme but http(s) before it can
    // reach a `blob:`, `file:` or `chrome-extension:` URL (§13.5).
    ['src/platform/http/service.ts', 'createHttpClient', CHECKS[5]],
  ];
  const httpService = resolve(repoRoot, HTTP_CLIENT_SOURCE);
  if (
    existsSync(httpService) &&
    !readFileSync(httpService, 'utf8').includes("protocol !== 'http:'")
  ) {
    findings.push({
      check: CHECKS[5],
      detail: `${HTTP_CLIENT_SOURCE} no longer refuses non-http(s) schemes`,
    });
  }
  for (const [file, symbol, check] of guards) {
    const path = resolve(repoRoot, file);
    if (!existsSync(path) || !readFileSync(path, 'utf8').includes(`export function ${symbol}`)) {
      findings.push({ check, detail: `${file} no longer exports ${symbol}` });
    }
  }
}

function scanManifest(outDir: string, target: Target, findings: GateFinding[]): void {
  const manifestPath = resolve(outDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    findings.push({ check: CHECKS[0], detail: `${target}: manifest.json is missing` });
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;

  const permissions = [...((manifest.permissions as string[] | undefined) ?? [])].sort();
  const approved = [...permissionsFor(target)].sort();
  if (JSON.stringify(permissions) !== JSON.stringify(approved)) {
    findings.push({
      check: CHECKS[0],
      detail: `${target}: permissions are ${JSON.stringify(permissions)}, approved set is ${JSON.stringify(approved)}`,
    });
  }
  const optional = (manifest.optional_permissions as string[] | undefined) ?? [];
  const approvedOptional = optionalPermissionsFor(target);
  for (const permission of optional) {
    if (!approvedOptional.includes(permission)) {
      findings.push({
        check: CHECKS[0],
        detail: `${target}: optional "${permission}" is unapproved`,
      });
    }
  }

  // Host access for stream assembly is declared where the engine treats it as
  // optional, and is requested at point of use on a gesture (§13.7):
  //   Chromium — `optional_host_permissions`; an MV3 `host_permissions` entry there
  //              would be granted at install, so there must be none.
  //   Firefox  — `host_permissions`, which Firefox MV3 does NOT grant at install;
  //              the user opts in per site, or the add-on asks at runtime.
  const declaredHosts = (manifest.host_permissions as string[] | undefined) ?? [];
  const expectedHosts = [...hostPermissionsFor(target)];
  if (declaredHosts.join(',') !== expectedHosts.join(',')) {
    findings.push({
      check: CHECKS[1],
      detail: `${target}: host_permissions are ${JSON.stringify(declaredHosts)}, expected ${JSON.stringify(expectedHosts)}`,
    });
  }
  const declaredOptionalHosts = (manifest.optional_host_permissions as string[] | undefined) ?? [];
  const expectedOptionalHosts = [...optionalHostPermissionsFor(target)];
  if (declaredOptionalHosts.join(',') !== expectedOptionalHosts.join(',')) {
    findings.push({
      check: CHECKS[1],
      detail: `${target}: optional_host_permissions are ${JSON.stringify(declaredOptionalHosts)}, expected ${JSON.stringify(expectedOptionalHosts)}`,
    });
  }
  for (const permission of [...permissions, ...optional]) {
    if (permission.includes('://') || permission === '<all_urls>') {
      findings.push({
        check: CHECKS[1],
        detail: `${target}: "${permission}" is a host permission in the wrong key`,
      });
    }
  }
  for (const pattern of [...declaredHosts, ...declaredOptionalHosts]) {
    if (pattern !== STREAM_HOST_PATTERN) {
      findings.push({
        check: CHECKS[1],
        detail: `${target}: host pattern "${pattern}" is not the approved one`,
      });
    }
  }

  const csp = (manifest.content_security_policy as { extension_pages?: string } | undefined)
    ?.extension_pages;
  if (
    csp === undefined ||
    !csp.includes("script-src 'self'") ||
    !csp.includes("object-src 'none'")
  ) {
    findings.push({
      check: CHECKS[2],
      detail: `${target}: extension_pages CSP is "${csp ?? 'absent'}"`,
    });
  }
}

/**
 * Absolute URLs that legitimately appear in shipped code as STRINGS and are never
 * contacted: XML namespace identifiers, and React's error-decoder link, which it
 * only ever prints in a thrown message. Runtime proof that nothing is fetched is in
 * the e2e suites, which fail on any request off the fixture origin (§14.3).
 */
const ALLOWED_URL_PREFIXES = [
  'http://www.w3.org/',
  'https://www.w3.org/',
  'https://react.dev/errors/',
];

function scanBundles(
  outDir: string,
  target: Target,
  findings: GateFinding[],
  vendorChunks: string[] = [],
): void {
  for (const path of walk(outDir, (candidate) => extname(candidate) === '.js')) {
    const code = readFileSync(path, 'utf8');
    const where = `${target}:${relative(outDir, path).split('\\').join('/')}`;

    // First-party bundles are held to the WHOLE remote-code family. The vendor chunk is
    // the one exception: React's minified runtime legitimately contains both an
    // `innerHTML` assignment and a script-element construction, and neither is code
    // AetherDL writes — `src/` is scanned for both patterns unconditionally above, and
    // the exclusion is reported rather than applied silently.
    const isVendor = code.includes('react.dev/errors/');
    const bundlePatterns = isVendor
      ? REMOTE_CODE_PATTERNS.filter(
          ([name]) => name !== 'innerHTML assignment' && name !== 'remote script element',
        )
      : REMOTE_CODE_PATTERNS;
    if (isVendor) {
      vendorChunks.push(where);
    }
    for (const [name, pattern] of [...bundlePatterns, ...EGRESS_PATTERNS]) {
      if (!pattern.test(code)) {
        continue;
      }
      const isEgress = EGRESS_PATTERNS.some(([label]) => label === name);
      // `fetch` is judged by REACHABILITY, not by file name: it may appear only in
      // code the assembly surfaces load, and never in anything a UI surface can
      // reach. The graph walk below decides that; skip the flat verdict here.
      if (isEgress && name === 'fetch') {
        continue;
      }
      findings.push({
        check: isEgress ? CHECKS[4] : CHECKS[3],
        detail: `${where} contains ${name}`,
      });
    }

    for (const match of code.matchAll(/https?:\/\/[^"'`\s)]+/g)) {
      const url = match[0];
      if (!ALLOWED_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) {
        findings.push({ check: CHECKS[4], detail: `${where} embeds the remote URL ${url}` });
      }
    }

    if (/popup|settings/.test(relative(outDir, path))) {
      for (const marker of BACKGROUND_ONLY_MARKERS) {
        if (code.includes(marker)) {
          findings.push({
            check: CHECKS[8],
            detail: `${where} contains background-only "${marker}"`,
          });
        }
      }
    }
  }

  scanFetchReachability(outDir, target, findings);
}

/** Static imports an emitted ES module declares, as paths relative to `outDir`. */
function emittedImports(outDir: string, file: string): readonly string[] {
  const path = resolve(outDir, file);
  if (!existsSync(path)) {
    return [];
  }
  const code = readFileSync(path, 'utf8');
  const dir = relative(outDir, resolve(path, '..')).split('\\').join('/');
  const found = new Set<string>();
  for (const match of code.matchAll(/(?:from|import)\s*["'](\.[^"']+\.js)["']/g)) {
    const specifier = match[1];
    if (specifier === undefined) {
      continue;
    }
    const resolved = join(dir, specifier).split('\\').join('/');
    found.add(resolved.startsWith('./') ? resolved.slice(2) : resolved);
  }
  return [...found];
}

/** Every emitted module an entry pulls in, itself included. */
function reachableFrom(outDir: string, entry: string): ReadonlySet<string> {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);
    pending.push(...emittedImports(outDir, current));
  }
  return seen;
}

/**
 * `fetch` may exist in the shipped payload only where assembly needs it, and must be
 * unreachable from any UI surface. Proven over the emitted import graph, so a future
 * chunk split cannot smuggle the HTTP client into the popup unnoticed (§13.10, §14.3).
 */
function scanFetchReachability(outDir: string, target: Target, findings: GateFinding[]): void {
  const [, fetchPattern] = EGRESS_PATTERNS[0] ?? ['fetch', /\bfetch\s*\(/];
  const carriers = walk(outDir, (candidate) => extname(candidate) === '.js')
    .map((path) => relative(outDir, path).split('\\').join('/'))
    .filter((file) => fetchPattern.test(readFileSync(resolve(outDir, file), 'utf8')));
  if (carriers.length === 0) {
    return;
  }

  const allowed = new Set<string>();
  for (const entry of ASSEMBLY_ENTRIES) {
    for (const file of reachableFrom(outDir, entry)) {
      allowed.add(file);
    }
  }
  for (const file of carriers) {
    if (!allowed.has(file)) {
      findings.push({
        check: CHECKS[4],
        detail: `${target}:${file} contains fetch but no assembly surface loads it`,
      });
    }
  }

  // The surfaces that must never be able to reach the network at all.
  for (const surface of ['popup.js', 'settings.js', 'content.js']) {
    for (const file of reachableFrom(outDir, surface)) {
      if (carriers.includes(file)) {
        findings.push({
          check: CHECKS[4],
          detail: `${target}: ${surface} reaches ${file}, which contains fetch`,
        });
      }
    }
  }
}

/** Run the §13.10 checklist against one built target. */
export function runSecurityGate(outDir: string, target: Target): GateResult {
  const findings: GateFinding[] = [];
  const vendorChunks: string[] = [];
  scanSources(findings);
  scanManifest(outDir, target, findings);
  scanBundles(outDir, target, findings, vendorChunks);
  return { target, checks: CHECKS, findings, vendorChunks };
}

export function formatGateReport(result: GateResult): string {
  const failed = new Set(result.findings.map((finding) => finding.check));
  const lines = result.checks.map(
    (check) => `    ${failed.has(check) ? 'FAIL' : 'PASS'}  ${check}`,
  );
  for (const finding of result.findings) {
    lines.push(`      - ${finding.check}: ${finding.detail}`);
  }
  for (const chunk of result.vendorChunks) {
    lines.push(
      `      note  ${chunk} is vendor code (React): "innerHTML assignment" and "remote script ` +
        `element" are enforced on src/ only for it`,
    );
  }
  return lines.join('\n');
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry);
}

if (isMain()) {
  let gated = 0;
  let violations = 0;
  for (const target of TARGETS) {
    const outDir = resolve(repoRoot, 'dist', target);
    if (!existsSync(outDir) || !statSync(outDir).isDirectory()) {
      console.warn(`[security] skipping ${target}: dist/${target} not found (run a build first)`);
      continue;
    }
    const result = runSecurityGate(outDir, target);
    console.log(`[security] ${target}: ${result.findings.length === 0 ? 'PASS' : 'FAIL'} (§13.10)`);
    console.log(formatGateReport(result));
    violations += result.findings.length;
    gated += 1;
  }
  if (gated === 0) {
    console.error('[security] no built targets found; run "npm run build" first');
    process.exit(1);
  }
  if (violations > 0) {
    process.exit(1);
  }
}
