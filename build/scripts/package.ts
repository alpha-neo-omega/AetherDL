/**
 * Module: build/scripts (package)
 * Purpose: Produce one store-ready artifact per target from an already-built
 *          extension (PROJECT_BIBLE.md §8.15: "one packaged artifact per store
 *          target"; §22.11 Phase 10 per-target packaged artifacts).
 * Responsibilities: Validate the built directory BEFORE producing anything (§8.15:
 *          packaging validates manifest correctness, CSP, permissions and bundle-size
 *          budgets first), then write a deterministic ZIP archive and record its
 *          SHA-256. Reproducible: entries are sorted and stamped with a fixed
 *          timestamp, so the same input yields byte-identical output for a given Node
 *          (and therefore zlib) version (§8.15 determinism).
 * Restrictions: Build tooling only. Reads `dist/<target>`; writes only under
 *          `dist/release`. No network access, no dependency beyond Node's own
 *          library, and it never rewrites the built extension.
 * Public API: RELEASE_TARGETS, ReleaseArtifact, zipDirectory, verifyArchive,
 *          extractArchive, packageTarget, packageRelease; CLI entry packages every
 *          built target.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { repoRoot } from '../vite/aliases';
import { TARGETS, type Target } from '../manifest/targets';
import { formatPayloadReport, measureSurfaces, validateExtension } from './validate';

/** A build target and the stores its single artifact serves (§7.1, §22.11). */
export interface ReleaseTarget {
  readonly target: Target;
  readonly stores: readonly string[];
}

export const RELEASE_TARGETS: readonly ReleaseTarget[] = [
  {
    target: 'chrome',
    stores: [
      'Chrome Web Store',
      'Microsoft Edge Add-ons',
      'Opera add-ons',
      'other Chromium-compatible stores (Brave, Vivaldi)',
    ],
  },
  { target: 'firefox', stores: ['Firefox Add-ons (AMO)'] },
];

export interface ReleaseArtifact {
  readonly target: Target;
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly entries: number;
  readonly stores: readonly string[];
}

/** 1980-01-01T00:00:00Z in DOS format — the earliest a ZIP can express. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Every file under `dir`, as forward-slash paths relative to it, sorted.
 *
 * Entries are classified by `statSync`, which follows symbolic links: a linked file is
 * part of the package, and dropping it silently would ship an extension missing a file
 * that every local check still found through the link.
 */
function collectFiles(dir: string, prefix = ''): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const name = prefix === '' ? entry : `${prefix}/${entry}`;
    const stats = statSync(join(dir, entry));
    if (stats.isDirectory()) {
      found.push(...collectFiles(join(dir, entry), name));
    } else if (stats.isFile()) {
      found.push(name);
    } else {
      throw new Error(`${name}: not a regular file or directory — refusing to package it`);
    }
  }
  return found.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

interface ZipEntry {
  readonly name: string;
  readonly crc: number;
  readonly compressed: Buffer;
  readonly rawSize: number;
  readonly method: number;
  readonly flags: number;
  readonly offset: number;
}

/**
 * Write `dir` to `archivePath` as a ZIP archive, deterministically. Both stores accept
 * a plain ZIP: Chromium packs one for the Web Store and AMO takes the same container
 * for an add-on.
 */
export function zipDirectory(dir: string, archivePath: string): { bytes: number; entries: number } {
  const names = collectFiles(dir);
  const parts: Buffer[] = [];
  const entries: ZipEntry[] = [];
  let offset = 0;

  for (const name of names) {
    const raw = readFileSync(join(dir, name));
    const deflated = deflateRawSync(raw, { level: 9 });
    // Store the file verbatim when compression would make it bigger (tiny assets).
    const useDeflate = deflated.length < raw.length;
    const compressed = useDeflate ? deflated : raw;
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(raw);
    // Bit 11 (EFS) tells a reader the name is UTF-8. Without it a non-ASCII name is
    // decoded as CP437 and the file extracts under a mangled name.
    const flags = nameBytes.equals(Buffer.from(name, 'latin1')) ? 0 : 0x0800;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    parts.push(local, nameBytes, compressed);
    entries.push({
      name,
      crc,
      compressed,
      rawSize: raw.length,
      method: useDeflate ? 8 : 0,
      flags,
      offset,
    });
    offset += local.length + nameBytes.length + compressed.length;
  }

  const centralStart = offset;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    // Version made by: Unix host (3), spec 3.0 — the host that gives the external
    // attribute field below its meaning.
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.compressed.length, 20);
    central.writeUInt32LE(entry.rawSize, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    // Regular file, rw-r--r--; the high half is the Unix mode.
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(entry.offset, 42);
    parts.push(central, nameBytes);
    offset += central.length + nameBytes.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  parts.push(end);

  const archive = Buffer.concat(parts);
  mkdirSync(resolve(archivePath, '..'), { recursive: true });
  writeFileSync(archivePath, archive);
  return { bytes: archive.length, entries: entries.length };
}

/**
 * Read a produced archive back and confirm it is a well-formed extension package:
 * the central directory parses, every entry's stored bytes match the CRC recorded for
 * them, and `manifest.json` is present. An artifact is only reported once it has
 * survived this — a corrupt package would otherwise be discovered by a store
 * reviewer instead of by the build (§8.15).
 */
export function verifyArchive(archivePath: string): { readonly entries: readonly string[] } {
  const archive = readFileSync(archivePath);
  const eocdOffset = archive.length - 22;
  if (eocdOffset < 0 || archive.readUInt32LE(eocdOffset) !== 0x06054b50) {
    throw new Error(`${archivePath}: not a ZIP archive (no end-of-central-directory record)`);
  }
  const count = archive.readUInt16LE(eocdOffset + 8);
  let cursor = archive.readUInt32LE(eocdOffset + 16);
  const names: string[] = [];

  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`${archivePath}: central directory entry ${String(index)} is malformed`);
    }
    const method = archive.readUInt16LE(cursor + 10);
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const rawSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    // Cross-check the LOCAL header against the central directory. A reader may use
    // either copy, so an archive whose two disagree is accepted by some tools and
    // rejected by others; the divergence has to fail here instead.
    if (archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`${archivePath}: "${name}" has no local file header`);
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localName = archive
      .subarray(localOffset + 30, localOffset + 30 + localNameLength)
      .toString('utf8');
    if (
      localName !== name ||
      archive.readUInt16LE(localOffset + 8) !== method ||
      archive.readUInt32LE(localOffset + 14) !== expectedCrc ||
      archive.readUInt32LE(localOffset + 18) !== compressedSize ||
      archive.readUInt32LE(localOffset + 22) !== rawSize
    ) {
      throw new Error(`${archivePath}: "${name}" local header disagrees with the directory`);
    }

    const dataStart = localOffset + 30 + localNameLength;
    const payload = archive.subarray(dataStart, dataStart + compressedSize);
    const restored = method === 8 ? inflateRawSync(payload) : Buffer.from(payload);
    if (crc32(restored) !== expectedCrc || restored.length !== rawSize) {
      throw new Error(`${archivePath}: "${name}" failed its checksum`);
    }
    names.push(name);
    cursor += 46 + nameLength;
  }

  if (!names.includes('manifest.json')) {
    throw new Error(`${archivePath}: no manifest.json — not an extension package`);
  }
  return { entries: names };
}

/**
 * Unpack an archive into `destDir`, so what a store would receive can be validated
 * and installed as-is rather than trusting the directory it was built from.
 */
export function extractArchive(archivePath: string, destDir: string): readonly string[] {
  const archive = readFileSync(archivePath);
  const eocdOffset = archive.length - 22;
  if (eocdOffset < 0 || archive.readUInt32LE(eocdOffset) !== 0x06054b50) {
    throw new Error(`${archivePath}: not a ZIP archive`);
  }
  const count = archive.readUInt16LE(eocdOffset + 8);
  let cursor = archive.readUInt32LE(eocdOffset + 16);
  const planned: { readonly name: string; readonly path: string; readonly contents: Buffer }[] = [];
  const root = resolve(destDir);

  for (let index = 0; index < count; index += 1) {
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    // Defence in depth (§13.8): work out where the entry would land and require that
    // it is inside the destination. A resolved-prefix check catches what a substring
    // test does not — a Windows drive letter, a backslash path, or a name that merely
    // contains two dots.
    const path = resolve(root, name.split('\\').join('/'));
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw new Error(`${archivePath}: refusing unsafe entry path "${name}"`);
    }

    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const dataStart = localOffset + 30 + localNameLength;
    const payload = archive.subarray(dataStart, dataStart + compressedSize);
    planned.push({
      name,
      path,
      contents: method === 8 ? inflateRawSync(payload) : Buffer.from(payload),
    });
    cursor += 46 + nameLength;
  }

  // Nothing is written until every entry has been vetted, so a hostile archive cannot
  // leave a half-extracted directory behind.
  for (const entry of planned) {
    mkdirSync(resolve(entry.path, '..'), { recursive: true });
    writeFileSync(entry.path, entry.contents);
  }

  return planned.map((entry) => entry.name);
}

/** Validate one built target and package it. Throws if validation fails. */
export function packageTarget(release: ReleaseTarget, version: string): ReleaseArtifact {
  const outDir = resolve(repoRoot, 'dist', release.target);
  if (!existsSync(join(outDir, 'manifest.json'))) {
    throw new Error(`dist/${release.target} is not built — run "npm run build" first`);
  }

  // §8.15: validate manifest correctness, CSP, permissions and the §12.1 budgets
  // BEFORE producing an artifact. A build that fails the gate is never packaged.
  validateExtension(outDir, release.target);

  // The artifact's name and its checksum record carry the release version, so the
  // build inside it has to BE that version: packaging a stale `dist/` under a fresh
  // name would ship the wrong bytes under the right label (§18.7 synchronized
  // versions across target builds).
  const built = (
    JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')) as { version?: unknown }
  ).version;
  if (built !== version) {
    throw new Error(
      `dist/${release.target} is built at version ${JSON.stringify(built)}, but the release is ` +
        `${version} — run "npm run build" again`,
    );
  }

  const archivePath = resolve(
    repoRoot,
    'dist',
    'release',
    `aetherdl-${version}-${release.target}.zip`,
  );
  const { bytes, entries } = zipDirectory(outDir, archivePath);
  verifyArchive(archivePath);
  const sha256 = createHash('sha256').update(readFileSync(archivePath)).digest('hex');

  return {
    target: release.target,
    file: relative(repoRoot, archivePath).split('\\').join('/'),
    bytes,
    sha256,
    entries,
    stores: release.stores,
  };
}

/** Package every built target and write the checksum record beside the artifacts. */
export function packageRelease(version: string): readonly ReleaseArtifact[] {
  // Clear archives from earlier runs first: a release directory holding two versions
  // beside a single checksum record is worse than no record at all.
  const releaseDir = resolve(repoRoot, 'dist', 'release');
  if (existsSync(releaseDir)) {
    for (const entry of readdirSync(releaseDir)) {
      if (entry.endsWith('.zip') || entry === 'SHA256SUMS.txt') {
        rmSync(join(releaseDir, entry), { force: true });
      }
    }
  }

  const artifacts = RELEASE_TARGETS.filter((release) => TARGETS.includes(release.target)).map(
    (release) => packageTarget(release, version),
  );

  const sums = artifacts
    .map((artifact) => `${artifact.sha256}  ${artifact.file.split('/').pop() ?? ''}`)
    .join('\n');
  writeFileSync(resolve(repoRoot, 'dist', 'release', 'SHA256SUMS.txt'), `${sums}\n`);
  return artifacts;
}

function readVersion(): string {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry);
}

if (isMain()) {
  const version = readVersion();
  const artifacts = packageRelease(version);
  for (const artifact of artifacts) {
    const kb = (artifact.bytes / 1024).toFixed(1);
    console.log(`[package] ${artifact.target}: dist/release → ${artifact.file}`);
    console.log(
      `    ${kb}kB, ${String(artifact.entries)} entries, sha256 ${artifact.sha256.slice(0, 16)}…`,
    );
    console.log(`    serves: ${artifact.stores.join(', ')}`);
    const outDir = resolve(repoRoot, 'dist', artifact.target);
    if (statSync(outDir).isDirectory()) {
      console.log(formatPayloadReport(measureSurfaces(outDir)));
    }
  }
  console.log(`[package] checksums → dist/release/SHA256SUMS.txt`);
}
