/**
 * Module: build/scripts (validate)
 * Purpose: Validate a built, unpacked extension directory (PROJECT_BIBLE.md §8.15:
 *          packaging validates manifest correctness, CSP, permissions, size budgets).
 * Responsibilities: Assert MV3 correctness, strict CSP (§13.2), least-privilege
 *          permissions (§13.3), presence of referenced files, and bundle-size
 *          budgets (§12.1).
 * Restrictions: Build tooling only. Read-only against the dist directory.
 * Public API: SURFACES, SurfacePayload, measureSurfacePayload, measureSurfaces,
 *          formatPayloadReport, validateExtension; CLI entry validates
 *          dist/<target> for all targets.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { repoRoot } from '../vite/aliases';
import {
  BASELINE_PERMISSIONS,
  optionalPermissionsFor,
  TARGETS,
  type Target,
} from '../manifest/targets';

/**
 * A shipped surface and the gzipped budget its WHOLE payload must fit inside
 * (PROJECT_BIBLE.md §12.1). The budget covers the entry plus every chunk it
 * reaches and any stylesheet its HTML shell links — measuring the entry alone
 * would under-report what the browser actually loads.
 */
export interface SurfaceSpec {
  readonly surface: string;
  readonly entry: string;
  /** HTML shell whose linked stylesheets count toward the surface (§12.1). */
  readonly html?: string;
  readonly budgetGz: number;
}

/**
 * The Firefox minimum the project committed to (§7.1 "latest stable + ESR"), asserted
 * here rather than read from the generator so that a change has to be made in both
 * places deliberately.
 */
const RATIFIED_FIREFOX_MIN_VERSION = '115.0';

export const SURFACES: readonly SurfaceSpec[] = [
  { surface: 'background', entry: 'background.js', budgetGz: 150 * 1024 },
  { surface: 'content', entry: 'content.js', budgetGz: 40 * 1024 },
  { surface: 'popup', entry: 'popup.js', html: 'popup.html', budgetGz: 200 * 1024 },
  { surface: 'settings', entry: 'settings.js', html: 'settings.html', budgetGz: 200 * 1024 },
];

export interface SurfacePayload {
  readonly surface: string;
  /** Every file the surface loads, relative to the output directory. */
  readonly files: readonly string[];
  readonly rawBytes: number;
  readonly gzipBytes: number;
  readonly budgetGz: number;
  readonly withinBudget: boolean;
}

/** Static ES import specifiers in an emitted bundle. */
const IMPORT_PATTERN = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+\.js)["']/g;
/** Stylesheet links in an emitted HTML shell. */
const STYLESHEET_PATTERN = /<link[^>]+href=["']([^"']+\.css)["']/g;

function collect(pattern: RegExp, text: string): readonly string[] {
  const found: string[] = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const specifier = match[1];
    if (specifier !== undefined) {
      found.push(specifier);
    }
  }
  return found;
}

/**
 * Walk a surface's transitive payload: the entry, every chunk reachable from it,
 * and the stylesheets its shell links. Relative specifiers only — an absolute or
 * remote URL is not something this build produces (§13.2, §14.3).
 */
export function measureSurfacePayload(outDir: string, spec: SurfaceSpec): SurfacePayload {
  const seen = new Set<string>();
  const queue: string[] = [];

  const enqueue = (path: string): void => {
    if (existsSync(path) && !seen.has(path)) {
      seen.add(path);
      queue.push(path);
    }
  };

  enqueue(resolve(outDir, spec.entry));
  if (spec.html !== undefined) {
    const shell = resolve(outDir, spec.html);
    if (existsSync(shell)) {
      for (const href of collect(STYLESHEET_PATTERN, readFileSync(shell, 'utf8'))) {
        enqueue(resolve(outDir, href));
      }
    }
  }

  let rawBytes = 0;
  let gzipBytes = 0;
  const files: string[] = [];
  while (queue.length > 0) {
    const path = queue.shift() as string;
    const contents = readFileSync(path);
    rawBytes += contents.length;
    gzipBytes += gzipSync(contents).length;
    files.push(relative(outDir, path).split('\\').join('/'));
    if (path.endsWith('.js')) {
      for (const specifier of collect(IMPORT_PATTERN, contents.toString('utf8'))) {
        if (specifier.startsWith('.')) {
          enqueue(resolve(dirname(path), specifier));
        }
      }
    }
  }

  return {
    surface: spec.surface,
    files: files.sort(),
    rawBytes,
    gzipBytes,
    budgetGz: spec.budgetGz,
    withinBudget: gzipBytes <= spec.budgetGz,
  };
}

/** Measure every shipped surface in an output directory. */
export function measureSurfaces(outDir: string): readonly SurfacePayload[] {
  return SURFACES.map((spec) => measureSurfacePayload(outDir, spec));
}

/** Human-readable payload report — the profiling evidence a build leaves behind. */
export function formatPayloadReport(payloads: readonly SurfacePayload[]): string {
  const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)}kB`;
  return payloads
    .map(
      (payload) =>
        `    ${payload.surface.padEnd(10)} ${kb(payload.gzipBytes).padStart(8)} gz` +
        ` / ${kb(payload.budgetGz)} budget` +
        ` (${String(payload.files.length)} file${payload.files.length === 1 ? '' : 's'},` +
        ` ${kb(payload.rawBytes)} raw)`,
    )
    .join('\n');
}

const REQUIRED_FILES = [
  'manifest.json',
  'background.js',
  'content.js',
  'popup.js',
  'settings.js',
  'popup.html',
  // The shared stylesheet both HTML shells link; a missing asset ships an unstyled UI.
  'assets/styles.css',
  'settings.html',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png',
  '_locales/en/messages.json',
];

function fail(messages: string[]): never {
  throw new Error(`Extension validation failed:\n  - ${messages.join('\n  - ')}`);
}

/** Validate a single unpacked extension directory. Throws on any violation. */
export function validateExtension(outDir: string, target: Target): void {
  const errors: string[] = [];

  for (const rel of REQUIRED_FILES) {
    if (!existsSync(resolve(outDir, rel))) {
      errors.push(`missing required file: ${rel}`);
    }
  }

  const manifestPath = resolve(outDir, 'manifest.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;

    if (manifest.manifest_version !== 3) {
      errors.push(`manifest_version must be 3 (found ${String(manifest.manifest_version)})`);
    }

    const csp = manifest.content_security_policy as { extension_pages?: string } | undefined;
    const pages = csp?.extension_pages ?? '';
    if (!pages.includes("script-src 'self'")) {
      errors.push("CSP must pin script-src to 'self' (§13.2)");
    }
    if (!pages.includes("object-src 'none'")) {
      errors.push("CSP must set object-src to 'none' (§13.2)");
    }

    const permissions = (manifest.permissions as string[] | undefined) ?? [];
    for (const perm of permissions) {
      if (!BASELINE_PERMISSIONS.includes(perm)) {
        errors.push(`permission "${perm}" is outside the approved baseline (§13.3)`);
      }
    }
    if (permissions.some((p) => p.includes('://') || p === '<all_urls>')) {
      errors.push('host permissions must not be declared at install (§13.7)');
    }

    const approvedOptional = optionalPermissionsFor(target);
    const optional = (manifest.optional_permissions as string[] | undefined) ?? [];
    for (const perm of optional) {
      if (!approvedOptional.includes(perm)) {
        errors.push(`optional permission "${perm}" is outside the approved set (§13.3)`);
      }
    }
    if (optional.some((p) => p.includes('://') || p === '<all_urls>')) {
      errors.push('broad host permissions must not be declared, even optionally (§13.7)');
    }

    const bg = manifest.background as { service_worker?: string; scripts?: string[] } | undefined;
    if (target === 'firefox' && !bg?.scripts) {
      errors.push('Firefox background must use background.scripts (§7.4)');
    }
    if (target === 'chrome' && !bg?.service_worker) {
      errors.push('Chromium background must use a service_worker (§7.5)');
    }

    // Firefox-only metadata. AMO requires the add-on to declare what data it
    // collects; AetherDL collects none (§14.1, §14.3), and a package missing the
    // declaration cannot be submitted (§22.11). Chromium ignores the key entirely,
    // so it must not appear there (§7.6 one generator, per-target output).
    const gecko = (
      manifest.browser_specific_settings as
        | {
            gecko?: {
              id?: unknown;
              strict_min_version?: unknown;
              data_collection_permissions?: { required?: unknown };
            };
          }
        | undefined
    )?.gecko;
    if (target === 'firefox') {
      if (typeof gecko?.id !== 'string' || gecko.id === '') {
        errors.push('Firefox manifest must declare browser_specific_settings.gecko.id (§7.4)');
      }
      // The minimum version is a support-matrix commitment, not an implementation
      // detail: §7.1 requires "latest stable + ESR", and the Owner ratified keeping
      // 115.0 when the data-collection key (Firefox 140+) was added, accepting the
      // linter's min-version warnings instead of dropping ESR users. Stated here
      // independently of the generator, so raising one without the other fails.
      if (gecko?.strict_min_version !== RATIFIED_FIREFOX_MIN_VERSION) {
        errors.push(
          `gecko.strict_min_version must be "${RATIFIED_FIREFOX_MIN_VERSION}" to keep Firefox ESR ` +
            `support (§7.1); found ${JSON.stringify(gecko?.strict_min_version)}`,
        );
      }
      const collected = gecko?.data_collection_permissions?.required;
      if (!Array.isArray(collected) || collected.length === 0) {
        errors.push(
          'Firefox manifest must declare gecko.data_collection_permissions.required (§22.11)',
        );
      } else if (collected.length !== 1 || collected[0] !== 'none') {
        errors.push(
          `gecko.data_collection_permissions.required must be ["none"] — AetherDL collects no ` +
            `data (§14.1, §14.3); found ${JSON.stringify(collected)}`,
        );
      }
    } else if (manifest.browser_specific_settings !== undefined) {
      errors.push('browser_specific_settings is Firefox-only and must not appear here (§7.6)');
    }
  }

  for (const payload of measureSurfaces(outDir)) {
    if (!payload.withinBudget) {
      errors.push(
        `${payload.surface} payload is ${payload.gzipBytes}B gz across ` +
          `${payload.files.length} file(s), over the ${payload.budgetGz}B budget (§12.1)`,
      );
    }
  }

  if (errors.length > 0) {
    fail(errors);
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry);
}

if (isMain()) {
  let validated = 0;
  for (const target of TARGETS) {
    const outDir = resolve(repoRoot, 'dist', target);
    if (!existsSync(outDir) || !statSync(outDir).isDirectory()) {
      console.warn(`[validate] skipping ${target}: dist/${target} not found (run a build first)`);
      continue;
    }
    validateExtension(outDir, target);
    console.log(`[validate] ${target}: OK`);
    console.log(formatPayloadReport(measureSurfaces(outDir)));
    validated += 1;
  }
  if (validated === 0) {
    console.error('[validate] no built targets found; run "npm run build" first');
    process.exit(1);
  }
}
