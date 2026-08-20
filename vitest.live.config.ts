/**
 * Vitest configuration for the real-world stream conformance suite (PROJECT_BIBLE.md
 * §16.9).
 *
 * NOT part of `npm run ci`, and deliberately so: these cases fetch public test
 * streams over the real network, so they can fail for reasons that have nothing to do
 * with this codebase (a CDN moves an asset, a link rots, the machine is offline). A
 * gate has to be a statement about the code. Run it by hand — `npm run test:live` —
 * and record what it said in docs/LIVE_STREAM_CHECK.md.
 *
 * Nothing is published or uploaded: every request is a GET for a manifest or a
 * segment prefix of content published for testing.
 */
import { defineConfig } from 'vitest/config';
import { aliases } from './build/vite/aliases';

export default defineConfig({
  resolve: {
    alias: Object.entries(aliases).map(([find, replacement]) => ({ find, replacement })),
  },
  test: {
    include: ['tests/live/**/*.test.ts'],
    environment: 'node',
    // One case at a time: these are network transfers, and interleaving them makes a
    // slow CDN look like a broken parser.
    fileParallelism: false,
    maxConcurrency: 1,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
