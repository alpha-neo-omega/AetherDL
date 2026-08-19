/**
 * Playwright configuration (PROJECT_BIBLE.md §16.3 Browser Tests).
 *
 * End-to-end browser tests run against locally-built, non-DRM fixtures only (§16.3)
 * — never against real protected services (§6). Each engine has its own spec because
 * the two install an extension by different mechanisms: Chromium loads the unpacked
 * build directly, Firefox installs a packaged build through web-ext (ADR-008).
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  // One worker: each spec launches a browser and installs the extension into it,
  // and two of those competing for CPU and for the fixture server made a
  // concurrency-sensitive case time out. Determinism matters more here than speed.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  projects: [
    {
      name: 'chromium',
      testMatch: /chromium\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      testMatch: /firefox\.spec\.ts$/,
      use: { ...devices['Desktop Firefox'] },
    },
  ],
});
