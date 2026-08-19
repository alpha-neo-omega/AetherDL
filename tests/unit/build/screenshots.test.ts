/**
 * Store screenshot capture (PROJECT_BIBLE.md §22.11 store assets).
 *
 * The capture itself needs a browser, so it is exercised by running the script; what
 * is unit-tested here is the part that decides WHAT gets photographed and where —
 * plus the refusal to photograph a build that does not exist.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  captureStoreScreenshots,
  DEVICE_SCALE_FACTOR,
  FIXTURE_PORT,
  SHOTS,
  STORE_VIEWPORT,
} from '../../../build/scripts/screenshots';

let emptyDir: string;

beforeEach(() => {
  emptyDir = mkdtempSync(join(tmpdir(), 'aetherdl-noshots-'));
});

afterEach(() => {
  rmSync(emptyDir, { recursive: true, force: true });
});

describe('the shot list', () => {
  it('photographs the store frame the Chrome Web Store accepts', () => {
    expect(STORE_VIEWPORT).toEqual({ width: 1280, height: 800 });
    expect(DEVICE_SCALE_FACTOR).toBeGreaterThanOrEqual(1);
  });

  it('pins the fixture port so repeated runs produce the same image', () => {
    // The media host is rendered on a card, so an ephemeral port would change every
    // asset (§8.15 determinism).
    expect(Number.isInteger(FIXTURE_PORT)).toBe(true);
    expect(FIXTURE_PORT).toBeGreaterThan(1024);
  });

  it('writes one file per shot, with no collisions', () => {
    const files = SHOTS.map((shot) => shot.file);
    expect(new Set(files).size).toBe(files.length);
    for (const file of files) {
      expect(file).toMatch(/^screenshot-\d+-[a-z0-9-]+\.png$/);
    }
  });

  it("photographs only the extension's own surfaces", () => {
    for (const shot of SHOTS) {
      expect(['popup.html', 'settings.html']).toContain(shot.page);
      expect(shot.ready).not.toBe('');
    }
  });

  it('covers the popup and the settings surface, and seeds media for the popup', () => {
    const popupShots = SHOTS.filter((shot) => shot.page === 'popup.html');
    const settingsShots = SHOTS.filter((shot) => shot.page === 'settings.html');

    expect(popupShots.length).toBeGreaterThan(0);
    expect(settingsShots.length).toBeGreaterThan(0);
    // A popup with no media would photograph the empty state, which is not the shot.
    expect(popupShots.every((shot) => shot.seedDetection === true)).toBe(true);
  });

  it('clips only where a full frame would be mostly empty', () => {
    const clipped = SHOTS.filter((shot) => shot.clipTo !== undefined);
    expect(clipped.every((shot) => shot.page === 'popup.html')).toBe(true);
  });
});

describe('capturing from a build that is not there', () => {
  it('refuses with the remedy, rather than launching a browser', async () => {
    await expect(captureStoreScreenshots({ extensionDir: emptyDir })).rejects.toThrow(
      /manifest\.json is missing — run "npm run build" first/,
    );
  });
});
