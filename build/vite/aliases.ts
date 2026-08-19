/**
 * Module: build/vite (path aliases)
 * Purpose: Single source of truth for the project's path aliases, shared by the
 *          Vite build and the Vitest config so resolution never drifts between
 *          build-time and test-time (PROJECT_BIBLE.md §8.4 dependency rules rely
 *          on these aliases; §15.9 boundary lint resolves them via tsconfig paths).
 * Responsibilities: Export the alias map as absolute filesystem paths.
 * Restrictions: Build tooling only. Contains no product logic.
 * Dependencies: node:path, node:url.
 * Public API: `aliases`, `repoRoot`.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the repository root (build/vite → repo root). */
export const repoRoot = resolve(here, '..', '..');

const src = resolve(repoRoot, 'src');

/** Alias map mirroring tsconfig.base.json `paths`. */
export const aliases: Record<string, string> = {
  '@shared': resolve(src, 'shared'),
  '@platform': resolve(src, 'platform'),
  '@core': resolve(src, 'core'),
  '@ui': resolve(src, 'ui'),
  '@runtime': resolve(src, 'runtime'),
};
