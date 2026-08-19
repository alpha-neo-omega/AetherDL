/**
 * Vitest configuration for the performance suite (PROJECT_BIBLE.md §16.4, §12.9).
 *
 * The §12.1 budgets are wall-clock measurements, so they are run on their own:
 * one fork, no file parallelism. Sharing CPUs with the rest of the suite would
 * measure the test runner's scheduling rather than AetherDL, and a loaded machine
 * would fail budgets the extension actually meets.
 */
import { defineConfig } from 'vitest/config';
import { aliases } from './build/vite/aliases';

export default defineConfig({
  resolve: {
    alias: Object.entries(aliases).map(([find, replacement]) => ({ find, replacement })),
  },
  test: {
    include: ['tests/performance/**/*.test.ts', 'tests/performance/**/*.test.tsx'],
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
    // One file at a time, in one fork: the measurements get the machine to themselves.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
