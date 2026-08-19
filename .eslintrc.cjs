// @ts-check
/**
 * AetherDL — ESLint configuration.
 *
 * Enforces the STATIC dependency rules of PROJECT_BIBLE.md §8.4 and §15.9:
 *   - dependencies flow downward only (shared ← platform ← core ← ui/runtime);
 *   - only `platform/` may reference `chrome` / `browser` globals;
 *   - no circular dependencies.
 *
 * ESLint is pinned to v8 so the frozen `.eslintrc.cjs` filename (PROJECT_BIBLE.md
 * §8.3) remains the authoritative config format. Type-aware rules are intentionally
 * NOT enabled in Phase 1; they are introduced with real async logic in a later phase.
 */

/** Forbidden import groups per layer (PROJECT_BIBLE.md §8.4). */
const forbid = (groups, message) => ['error', { patterns: [{ group: groups, message }] }];

module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    // The popup UI is React (ADR-003 framework ratification); .tsx needs JSX parsing.
    ecmaFeatures: { jsx: true },
  },
  env: {
    browser: true,
    es2022: true,
  },
  plugins: ['@typescript-eslint', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:import/recommended',
    'plugin:import/typescript',
    'prettier',
  ],
  settings: {
    'import/resolver': {
      typescript: {
        project: './tsconfig.json',
      },
    },
  },
  ignorePatterns: [
    'node_modules',
    'dist',
    'coverage',
    'playwright-report',
    'test-results',
    'public/icons',
    '*.cjs',
  ],
  rules: {
    // TypeScript owns undefined-symbol checking; disabling avoids false positives.
    'no-undef': 'off',
    'no-console': 'error',
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-restricted-globals': [
      'error',
      {
        name: 'chrome',
        message: 'Browser globals are allowed only in src/platform/ (PROJECT_BIBLE.md §8.4).',
      },
      {
        name: 'browser',
        message: 'Browser globals are allowed only in src/platform/ (PROJECT_BIBLE.md §8.4).',
      },
    ],
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    'import/no-cycle': ['error', { maxDepth: Infinity }],
    'import/no-self-import': 'error',
    'import/no-useless-path-segments': 'error',
    'import/no-unresolved': 'off',
  },
  overrides: [
    // ---- Layer dependency boundaries (PROJECT_BIBLE.md §8.4) ----
    {
      files: ['src/shared/**/*.{ts,tsx}'],
      rules: {
        'no-restricted-imports': forbid(
          [
            '@platform',
            '@platform/*',
            '@core',
            '@core/*',
            '@ui',
            '@ui/*',
            '@runtime',
            '@runtime/*',
          ],
          'shared/ is the leaf layer and MUST NOT depend on any other internal layer (PROJECT_BIBLE.md §8.4).',
        ),
      },
    },
    {
      files: ['src/platform/**/*.{ts,tsx}'],
      rules: {
        // Only platform/ may reference browser globals.
        'no-restricted-globals': 'off',
        'no-restricted-imports': forbid(
          ['@core', '@core/*', '@ui', '@ui/*', '@runtime', '@runtime/*'],
          'platform/ may depend only on shared/ (PROJECT_BIBLE.md §8.4).',
        ),
      },
    },
    {
      files: ['src/core/**/*.{ts,tsx}'],
      rules: {
        'no-restricted-imports': forbid(
          ['@ui', '@ui/*', '@runtime', '@runtime/*'],
          'core/ may depend on platform interfaces and shared/ only, never ui/ or runtime/ (PROJECT_BIBLE.md §8.4).',
        ),
      },
    },
    {
      files: ['src/ui/**/*.{ts,tsx}'],
      rules: {
        'no-restricted-imports': forbid(
          ['@platform', '@platform/*', '@runtime', '@runtime/*'],
          'ui/ must talk to core/ services, never platform/ directly or runtime/ (PROJECT_BIBLE.md §8.4).',
        ),
      },
    },
    // ---- Build tooling and configs run in Node ----
    {
      files: ['build/**/*.ts', 'vitest.config.ts', 'playwright.config.ts'],
      env: { node: true, browser: false },
      rules: {
        'no-console': 'off',
        'no-restricted-globals': 'off',
      },
    },
    // ---- The dev-only logger is the single sanctioned console boundary (§20.6) ----
    {
      files: ['src/shared/logging/**/*.ts'],
      rules: {
        'no-console': 'off',
      },
    },
    // ---- Tests ----
    {
      files: ['tests/**/*.{ts,tsx}'],
      env: { node: true },
      rules: {
        'no-console': 'off',
      },
    },
    {
      // Browser e2e drives a REAL browser: the callbacks handed to Playwright run
      // inside the page or the extension's service worker, where `chrome` is the
      // browser's own global rather than product code reaching for it. The §8.4
      // boundary still applies to everything under src/.
      files: ['tests/e2e/**/*.{ts,tsx}'],
      rules: {
        'no-restricted-globals': 'off',
      },
    },
  ],
};
