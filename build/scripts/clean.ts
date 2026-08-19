/**
 * Module: build/scripts (clean)
 * Purpose: Remove build and coverage output directories.
 * Restrictions: Build tooling only. Deletes generated artifacts only — never source.
 * Usage: tsx build/scripts/clean.ts
 */
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { repoRoot } from '../vite/aliases';

const ARTIFACTS = ['dist', 'coverage', 'playwright-report', 'test-results'];

async function main(): Promise<void> {
  for (const artifact of ARTIFACTS) {
    await rm(resolve(repoRoot, artifact), { recursive: true, force: true });
    console.log(`[clean] removed ${artifact}`);
  }
}

main().catch((error: unknown) => {
  console.error('[clean] failed:', error);
  process.exit(1);
});
