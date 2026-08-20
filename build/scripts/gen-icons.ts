/**
 * Module: build/scripts (gen-icons)
 * Purpose: Render the extension's icon set as PNG files — the real mark, not a
 *          placeholder (PROJECT_BIBLE.md §11.10).
 * Rationale: The manifest requires icons at 16/32/48/128, and every store shows them
 *          before a user has read a word of the listing. The mark is drawn here rather
 *          than imported as a binary blob so it stays reviewable in the repository, and
 *          the output is deterministic: same source, same bytes (§8.15).
 * Restrictions: Build tooling only. No dependencies, no randomness, no network.
 * Design: A rounded indigo tile carrying the download glyph — a downward arrow over a
 *          tray line. Chosen to survive 16px, where anything more detailed turns to
 *          mush: two solid white shapes on a solid field, no thin strokes, no text.
 *          Shapes are described in normalized coordinates and sampled 4×4 per pixel, so
 *          every size is rendered rather than scaled.
 * Usage: tsx build/scripts/gen-icons.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { repoRoot } from '../vite/aliases';

const ICON_SIZES = [16, 32, 48, 128] as const;

type Rgb = readonly [number, number, number];

/** AetherDL indigo, top and bottom of a slight vertical gradient. */
const BRAND_TOP: Rgb = [92, 124, 250];
const BRAND_BOTTOM: Rgb = [61, 87, 216];
const GLYPH: Rgb = [255, 255, 255];

/** Samples per pixel per axis. 4×4 = 16 samples: enough to hide the stair-steps. */
const SUBSAMPLES = 4;

/** Corner radius of the tile, as a fraction of its side. */
const TILE_RADIUS = 0.22;

// The glyph, in normalized coordinates (0 = left/top, 1 = right/bottom of the tile).
const STEM = { left: 0.435, right: 0.565, top: 0.2, bottom: 0.5 } as const;
const HEAD = { apexY: 0.72, shoulderY: 0.44, left: 0.29, right: 0.71 } as const;
// Thick enough to survive 16px: at 0.085 of the tile the tray was 1.4 pixels tall
// there and rendered as a grey smear rather than a white bar.
const TRAY = { left: 0.25, right: 0.75, top: 0.775, bottom: 0.9 } as const;

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ buffer[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** Inside the rounded square that fills the canvas. */
function insideTile(x: number, y: number): boolean {
  const r = TILE_RADIUS;
  const cx = x < r ? r : x > 1 - r ? 1 - r : x;
  const cy = y < r ? r : y > 1 - r ? 1 - r : y;
  if (cx === x || cy === y) {
    // Along an edge, not in a corner: the straight part of the shape.
    return x >= 0 && x <= 1 && y >= 0 && y <= 1;
  }
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** Inside the arrow (stem plus head) or the tray beneath it. */
function insideGlyph(x: number, y: number): boolean {
  if (x >= STEM.left && x <= STEM.right && y >= STEM.top && y <= STEM.bottom) {
    return true;
  }
  if (y >= HEAD.shoulderY && y <= HEAD.apexY) {
    // The head narrows linearly from its shoulders to the apex.
    const t = (y - HEAD.shoulderY) / (HEAD.apexY - HEAD.shoulderY);
    const half = ((HEAD.right - HEAD.left) / 2) * (1 - t);
    const centre = (HEAD.left + HEAD.right) / 2;
    if (x >= centre - half && x <= centre + half) {
      return true;
    }
  }
  if (y >= TRAY.top && y <= TRAY.bottom) {
    // Rounded ends, so the tray does not read as a hard bar at small sizes.
    const radius = (TRAY.bottom - TRAY.top) / 2;
    const midY = (TRAY.top + TRAY.bottom) / 2;
    if (x >= TRAY.left + radius && x <= TRAY.right - radius) {
      return true;
    }
    const capX = x < TRAY.left + radius ? TRAY.left + radius : TRAY.right - radius;
    const dx = x - capX;
    const dy = y - midY;
    return dx * dx + dy * dy <= radius * radius;
  }
  return false;
}

function mix(from: Rgb, to: Rgb, t: number): Rgb {
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
  ];
}

/** Render one icon: RGBA pixels, anti-aliased by supersampling. */
function renderIcon(size: number): Buffer {
  const bytesPerRow = size * 4 + 1;
  const raw = Buffer.alloc(bytesPerRow * size);
  const step = 1 / (size * SUBSAMPLES);

  for (let py = 0; py < size; py += 1) {
    const rowStart = py * bytesPerRow;
    raw[rowStart] = 0; // filter: none
    for (let px = 0; px < size; px += 1) {
      let tileHits = 0;
      let glyphHits = 0;
      for (let sy = 0; sy < SUBSAMPLES; sy += 1) {
        for (let sx = 0; sx < SUBSAMPLES; sx += 1) {
          const x = (px * SUBSAMPLES + sx + 0.5) * step;
          const y = (py * SUBSAMPLES + sy + 0.5) * step;
          if (!insideTile(x, y)) {
            continue;
          }
          tileHits += 1;
          if (insideGlyph(x, y)) {
            glyphHits += 1;
          }
        }
      }
      const samples = SUBSAMPLES * SUBSAMPLES;
      const offset = rowStart + 1 + px * 4;
      if (tileHits === 0) {
        // Fully outside: transparent, so the icon is a tile and not a square photo.
        continue;
      }
      const field = mix(BRAND_TOP, BRAND_BOTTOM, (py + 0.5) / size);
      // Average the two fills over the samples that landed inside the tile, so a pixel
      // on the glyph's edge is a blend rather than a jagged step.
      const glyphShare = glyphHits / tileHits;
      const colour = mix(field, GLYPH, glyphShare);
      raw[offset] = colour[0];
      raw[offset + 1] = colour[1];
      raw[offset + 2] = colour[2];
      raw[offset + 3] = Math.round((tileHits / samples) * 255);
    }
  }
  return raw;
}

export function iconPng(size: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(renderIcon(size), { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main(): Promise<void> {
  const iconsDir = resolve(repoRoot, 'public', 'icons');
  await mkdir(iconsDir, { recursive: true });
  for (const size of ICON_SIZES) {
    const file = resolve(iconsDir, `icon-${size}.png`);
    const png = iconPng(size);
    await writeFile(file, png);
    console.log(`[gen:icons] wrote icons/icon-${size}.png (${String(png.length)} bytes)`);
  }
}

// Only run when invoked directly, so the renderer can be imported by tests.
if (
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')
) {
  main().catch((error: unknown) => {
    console.error('[gen:icons] failed:', error);
    process.exit(1);
  });
}
