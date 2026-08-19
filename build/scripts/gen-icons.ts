/**
 * Module: build/scripts (gen-icons)
 * Purpose: Generate the extension's placeholder icon assets as valid PNG files.
 * Rationale: The manifest requires real icon files at all sizes. These are solid
 *          brand-color placeholders; the final Material Design 3 icon set is
 *          produced in the UI phase (PROJECT_BIBLE.md §11.10). Icons are committed
 *          static assets under public/icons and copied verbatim into each build.
 * Restrictions: Build tooling only. Deterministic output (no randomness).
 * Usage: tsx build/scripts/gen-icons.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { repoRoot } from '../vite/aliases';

const ICON_SIZES = [16, 32, 48, 128] as const;

/** AetherDL brand indigo. */
const BRAND: readonly [number, number, number, number] = [76, 110, 245, 255];

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

function solidPng(size: number, [r, g, b, a]: readonly [number, number, number, number]): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const bytesPerRow = size * 4 + 1;
  const raw = Buffer.alloc(bytesPerRow * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * bytesPerRow;
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < size; x += 1) {
      const pixel = rowStart + 1 + x * 4;
      raw[pixel] = r;
      raw[pixel + 1] = g;
      raw[pixel + 2] = b;
      raw[pixel + 3] = a;
    }
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main(): Promise<void> {
  const iconsDir = resolve(repoRoot, 'public', 'icons');
  await mkdir(iconsDir, { recursive: true });
  for (const size of ICON_SIZES) {
    const file = resolve(iconsDir, `icon-${size}.png`);
    await writeFile(file, solidPng(size, BRAND));
    console.log(`[gen:icons] wrote icons/icon-${size}.png`);
  }
}

main().catch((error: unknown) => {
  console.error('[gen:icons] failed:', error);
  process.exit(1);
});
