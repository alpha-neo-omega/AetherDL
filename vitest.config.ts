/**
 * Vitest configuration (PROJECT_BIBLE.md §16 Testing).
 *
 * Unit, integration, accessibility and regression tests run in a jsdom-free Node
 * environment by default; suites that need the DOM opt in per-file. Coverage is collected but
 * thresholds are NOT enforced in Phase 1 — the ≥90% core-logic target (§16.1)
 * applies once domain logic exists (Phase 3+).
 */
import { defineConfig } from 'vitest/config';
import { aliases } from './build/vite/aliases';

export default defineConfig({
  resolve: {
    alias: Object.entries(aliases).map(([find, replacement]) => ({ find, replacement })),
  },
  test: {
    include: [
      'tests/unit/**/*.test.ts',
      'tests/unit/**/*.test.tsx',
      'tests/integration/**/*.test.ts',
      'tests/integration/**/*.test.tsx',
      // Accessibility (§16.6) and regression (§16.5) suites run with the same
      // runner: they assert behaviour, not wall-clock budgets.
      'tests/accessibility/**/*.test.ts',
      'tests/accessibility/**/*.test.tsx',
      'tests/regression/**/*.test.ts',
      'tests/regression/**/*.test.tsx',
      // The performance suite (§12, §16.4) runs from vitest.perf.config.ts: its
      // wall-clock budgets need the machine to themselves (`npm run test:perf`).
    ],
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      // Entry composition roots (index.ts) touch ambient browser/DOM globals and are
      // excluded; runtime LOGIC files (runtime.ts, state.ts, badge.ts, observer.ts,
      // scan.ts, context.ts) are measured against the ≥90% target (§16.1).
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/index.ts', 'src/**/index.tsx'],
    },
  },
});
