/**
 * Module: build/scripts (build-extension)
 * Purpose: Orchestrate the per-target extension build from a single source tree
 *          (PROJECT_BIBLE.md §8.15 build & packaging; §7.6 per-target outputs).
 * Responsibilities: Run the Vite build for each target, assemble the HTML shells,
 *          write the generated manifest, and validate the result.
 * Restrictions: Build tooling only. Guarantees identical source across targets;
 *          only the generated manifest differs (§7.2).
 * Usage: tsx build/scripts/build-extension.ts <chrome|firefox|all> [--watch] [--mode <m>]
 */
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';
import { repoRoot } from '../vite/aliases';
import { createContentViteConfig, createViteConfig } from '../vite/config';
import { TARGETS, type BuildContext, type BuildMode, type Target } from '../manifest/targets';
import { generateManifest } from '../manifest/generate';
import { formatPayloadReport, measureSurfaces, validateExtension } from './validate';

interface Watcher {
  on(event: 'event', callback: (payload: { code: string }) => void): void;
}

function parseArgs(argv: string[]): { selector: string; watch: boolean; mode: BuildMode } {
  const selector = argv.find((arg) => !arg.startsWith('--')) ?? 'all';
  const watch = argv.includes('--watch');
  let mode: BuildMode = 'production';
  const inline = argv.find((arg) => arg.startsWith('--mode='));
  if (inline) {
    mode = inline.slice('--mode='.length) === 'development' ? 'development' : 'production';
  } else {
    const flagIndex = argv.indexOf('--mode');
    if (flagIndex >= 0 && argv[flagIndex + 1] === 'development') {
      mode = 'development';
    }
  }
  return { selector, watch, mode };
}

function resolveTargets(selector: string): Target[] {
  if (selector === 'all') {
    return [...TARGETS];
  }
  if (selector === 'chrome' || selector === 'firefox') {
    return [selector];
  }
  throw new Error(`Unknown build target "${selector}" (expected chrome | firefox | all)`);
}

async function readVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

/** Assemble non-bundled outputs and validate a built target directory. */
async function finalize(ctx: BuildContext): Promise<void> {
  const outDir = resolve(repoRoot, 'dist', ctx.target);
  const runtime = resolve(repoRoot, 'src', 'runtime');

  await copyFile(resolve(runtime, 'popup', 'index.html'), resolve(outDir, 'popup.html'));
  await copyFile(resolve(runtime, 'settings', 'index.html'), resolve(outDir, 'settings.html'));
  await copyFile(resolve(runtime, 'offscreen', 'index.html'), resolve(outDir, 'offscreen.html'));

  const manifest = generateManifest(ctx);
  await writeFile(
    resolve(outDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  validateExtension(outDir, ctx.target);
  console.log(`[build] ${ctx.target} (${ctx.mode}): OK -> dist/${ctx.target}`);
  // Payload report: the profiling evidence every build leaves behind (§12.1).
  console.log(formatPayloadReport(measureSurfaces(outDir)));
}

async function buildTarget(ctx: BuildContext, watch: boolean): Promise<void> {
  const config = createViteConfig(ctx);
  // The content script is emitted by a second pass so it stays self-contained; it
  // always runs after the module build, which is the pass that empties the outDir.
  const contentConfig = createContentViteConfig(ctx);
  if (watch) {
    const watcher = (await build({
      ...config,
      build: { ...config.build, watch: {} },
    })) as unknown as Watcher;
    watcher.on('event', (payload) => {
      if (payload.code === 'END') {
        void (async (): Promise<void> => {
          await build(contentConfig);
          await finalize(ctx);
        })().catch((error: unknown) => {
          console.error(`[build] ${ctx.target} finalize failed:`, error);
        });
      }
    });
    console.log(`[build] watching ${ctx.target} (${ctx.mode})`);
    return;
  }
  await build(config);
  await build(contentConfig);
  await finalize(ctx);
}

async function main(): Promise<void> {
  const { selector, watch, mode } = parseArgs(process.argv.slice(2));
  const targets = resolveTargets(selector);
  const version = await readVersion();

  for (const target of targets) {
    await buildTarget({ target, mode, version }, watch);
  }
}

main().catch((error: unknown) => {
  console.error('[build] failed:', error);
  process.exit(1);
});
