/**
 * Module: build/vite (config factory)
 * Purpose: Produce the Vite build configuration for a given target/mode
 *          (PROJECT_BIBLE.md §8.15 build architecture; ADR-002 build tooling).
 * Responsibilities: Define the four extension entry points (background, content,
 *          popup, settings) as ES bundles with stable filenames the generated
 *          manifest and HTML shells reference.
 * Restrictions: Build tooling only. The SAME source tree feeds every target; no
 *          per-browser source forks (§7.2).
 * Public API: createViteConfig, createContentViteConfig.
 */
import { resolve } from 'node:path';
import type { InlineConfig } from 'vite';
import { aliases, repoRoot } from './aliases';
import type { BuildContext } from '../manifest/targets';

function baseConfig(ctx: BuildContext): InlineConfig {
  return {
    root: repoRoot,
    configFile: false,
    mode: ctx.mode,
    logLevel: 'warn',
    resolve: {
      alias: Object.entries(aliases).map(([find, replacement]) => ({ find, replacement })),
    },
    build: {
      outDir: resolve(repoRoot, 'dist', ctx.target),
      target: 'es2022',
      minify: ctx.mode === 'production',
      sourcemap: ctx.mode !== 'production',
      modulePreload: false,
      reportCompressedSize: false,
    },
  };
}

/**
 * The module surfaces: the background worker/event page and the two extension
 * pages. They load as ES modules, so Rollup may hoist what they share into chunks —
 * which is how React is downloaded and parsed once for both pages rather than twice
 * (§12.1 popup bundle budget).
 */
export function createViteConfig(ctx: BuildContext): InlineConfig {
  const runtime = resolve(repoRoot, 'src', 'runtime');
  const base = baseConfig(ctx);
  return {
    ...base,
    build: {
      ...base.build,
      emptyOutDir: true,
      rollupOptions: {
        input: {
          background: resolve(runtime, 'background', 'index.ts'),
          popup: resolve(runtime, 'popup', 'index.ts'),
          settings: resolve(runtime, 'settings', 'index.ts'),
        },
        output: {
          format: 'es',
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name].js',
          assetFileNames: 'assets/[name][extname]',
        },
      },
    },
  };
}

/**
 * The content script is built on its own so it emits ONE self-contained file
 * (PROJECT_BIBLE.md §12.1: "injected on pages; must be tiny"). It must not import a
 * shared chunk: a content script is injected as a classic script, so an ES import
 * would not resolve, and every page load would otherwise pay for code the page does
 * not need. Runs after the module build, which owns `emptyOutDir`.
 */
export function createContentViteConfig(ctx: BuildContext): InlineConfig {
  const base = baseConfig(ctx);
  return {
    ...base,
    build: {
      ...base.build,
      emptyOutDir: false,
      rollupOptions: {
        input: resolve(repoRoot, 'src', 'runtime', 'content', 'index.ts'),
        output: {
          format: 'iife',
          inlineDynamicImports: true,
          entryFileNames: 'content.js',
          assetFileNames: 'assets/[name][extname]',
        },
      },
    },
  };
}
