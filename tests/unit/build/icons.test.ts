/**
 * The icon set (PROJECT_BIBLE.md §11.10). Every store shows these before a user has
 * read a word of the listing, and for four releases they were solid-colour
 * placeholders. These assertions describe what the mark IS — a rounded tile carrying a
 * white download glyph — so it cannot quietly go back to being a square of paint.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../../../build/vite/aliases';
import { iconPng } from '../../../build/scripts/gen-icons';

const SIZES = [16, 32, 48, 128] as const;

interface Decoded {
  readonly width: number;
  readonly height: number;
  pixel(x: number, y: number): readonly [number, number, number, number];
}

/**
 * Decode one of our own PNGs: 8-bit RGBA, no interlace, filter 0 on every row. Written
 * out rather than pulled in, so the test reads the bytes the store will read.
 */
function decode(png: Buffer): Decoded {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let cursor = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];

  while (cursor < png.length) {
    const length = png.readUInt32BE(cursor);
    const type = png.subarray(cursor + 4, cursor + 8).toString('ascii');
    const data = png.subarray(cursor + 8, cursor + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect(data[8], 'bit depth').toBe(8);
      expect(data[9], 'colour type RGBA').toBe(6);
      expect(data[12], 'interlace').toBe(0);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    }
    cursor += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4 + 1;
  return {
    width,
    height,
    pixel(x, y) {
      expect(raw[y * stride], 'row filter').toBe(0);
      const at = y * stride + 1 + x * 4;
      return [raw[at] ?? 0, raw[at + 1] ?? 0, raw[at + 2] ?? 0, raw[at + 3] ?? 0];
    },
  };
}

const isWhite = ([r, g, b, a]: readonly number[]): boolean =>
  (r ?? 0) > 230 && (g ?? 0) > 230 && (b ?? 0) > 230 && (a ?? 0) > 240;

const isIndigo = ([r, , b, a]: readonly number[]): boolean =>
  (b ?? 0) > (r ?? 0) + 40 && (r ?? 0) > 30 && (r ?? 0) < 160 && (a ?? 0) > 240;

describe('icon assets', () => {
  it.each(SIZES)('renders %ipx at the size the manifest declares', (size) => {
    const decoded = decode(iconPng(size));

    expect(decoded.width).toBe(size);
    expect(decoded.height).toBe(size);
  });

  it.each(SIZES)('%ipx is a tile with rounded corners, not a full square', (size) => {
    const decoded = decode(iconPng(size));

    // The very corner is outside the rounded shape, so it is transparent.
    expect(decoded.pixel(0, 0)[3]).toBe(0);
    expect(decoded.pixel(size - 1, size - 1)[3]).toBe(0);
    // The middle of each edge is inside it.
    expect(decoded.pixel(Math.floor(size / 2), 1)[3]).toBeGreaterThan(200);
    expect(decoded.pixel(1, Math.floor(size / 2))[3]).toBeGreaterThan(200);
  });

  it.each(SIZES)('%ipx carries a white glyph on an indigo field', (size) => {
    const decoded = decode(iconPng(size));
    const mid = Math.floor(size / 2);

    // The arrow's stem runs down the middle; the tray sits near the bottom.
    expect(isWhite(decoded.pixel(mid, Math.round(size * 0.3))), 'arrow stem').toBe(true);
    expect(isWhite(decoded.pixel(mid, Math.round(size * 0.84))), 'tray').toBe(true);
    // Field either side of the stem.
    expect(isIndigo(decoded.pixel(Math.round(size * 0.15), mid)), 'field left').toBe(true);
    expect(isIndigo(decoded.pixel(Math.round(size * 0.85), mid)), 'field right').toBe(true);
  });

  // The gap between the arrow's apex and the tray is 0.055 of the tile — under one
  // pixel at 16px, where it can only be a blend. It is asserted where it is a real
  // separation rather than pretended at every size.
  it.each([32, 48, 128])('%ipx keeps the arrow and the tray apart', (size) => {
    const decoded = decode(iconPng(size));

    expect(isIndigo(decoded.pixel(Math.floor(size / 2), Math.round(size * 0.75)))).toBe(true);
  });

  it('is not a solid colour — the placeholder it replaced was', () => {
    const decoded = decode(iconPng(48));
    const seen = new Set<string>();
    for (let y = 0; y < 48; y += 1) {
      for (let x = 0; x < 48; x += 1) {
        seen.add(decoded.pixel(x, y).join(','));
      }
    }

    expect(seen.size).toBeGreaterThan(20);
  });

  it('renders the same bytes every time, so a build is reproducible (§8.15)', () => {
    expect(iconPng(128).equals(iconPng(128))).toBe(true);
  });

  it('matches the files committed under public/icons', () => {
    for (const size of SIZES) {
      const committed = readFileSync(resolve(repoRoot, 'public', 'icons', `icon-${size}.png`));
      expect(
        committed.equals(iconPng(size)),
        `icon-${size}.png is stale — run "npm run gen:icons"`,
      ).toBe(true);
    }
  });
});
