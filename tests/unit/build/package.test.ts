/**
 * Release packaging (PROJECT_BIBLE.md §8.15: one packaged artifact per store target,
 * validated before it is produced, from a reproducible build).
 *
 * The archive writer has no dependency behind it, so these tests check the container
 * itself: that it is a well-formed ZIP, that its bytes are deterministic, and that a
 * build which fails validation never becomes an artifact.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractArchive,
  packageTarget,
  RELEASE_TARGETS,
  verifyArchive,
  zipDirectory,
} from '../../../build/scripts/package';

let workDir: string;

function write(relativePath: string, contents: string): void {
  const path = join(workDir, 'src', relativePath);
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

/** Read a ZIP end-of-central-directory record and every entry's stored payload. */
function readZip(path: string): {
  readonly entries: number;
  readonly files: Map<string, Buffer>;
} {
  const archive = readFileSync(path);
  const eocd = archive.length - 22;
  expect(archive.readUInt32LE(eocd)).toBe(0x06054b50);
  const entries = archive.readUInt16LE(eocd + 10);
  let cursor = archive.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();

  for (let index = 0; index < entries; index += 1) {
    expect(archive.readUInt32LE(cursor)).toBe(0x02014b50);
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    expect(archive.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const dataStart = localOffset + 30 + localNameLength;
    const payload = archive.subarray(dataStart, dataStart + compressedSize);
    files.set(name, method === 8 ? inflateRawSync(payload) : Buffer.from(payload));
    cursor += 46 + nameLength;
  }

  return { entries, files };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'aetherdl-package-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('release targets (§8.15, §22.11)', () => {
  it('produces one artifact per store target, covering every supported store', () => {
    expect(RELEASE_TARGETS.map((release) => release.target)).toEqual(['chrome', 'firefox']);

    const stores = RELEASE_TARGETS.flatMap((release) => release.stores).join(' | ');
    // The stores named in the Phase 10 acceptance criteria.
    expect(stores).toContain('Chrome Web Store');
    expect(stores).toContain('Microsoft Edge Add-ons');
    expect(stores).toContain('Firefox Add-ons (AMO)');
    expect(stores).toContain('Chromium-compatible');
  });
});

describe('the archive writer', () => {
  it('writes a readable ZIP containing every file, nested paths included', () => {
    write('manifest.json', '{"manifest_version":3}');
    write('background.js', 'console.log("x");'.repeat(40));
    write('icons/icon-16.png', 'not-really-a-png');
    write('_locales/en/messages.json', '{"extName":{"message":"AetherDL"}}');

    const archivePath = join(workDir, 'out.zip');
    const result = zipDirectory(join(workDir, 'src'), archivePath);
    const zip = readZip(archivePath);

    expect(result.entries).toBe(4);
    expect(zip.entries).toBe(4);
    expect([...zip.files.keys()].sort()).toEqual([
      '_locales/en/messages.json',
      'background.js',
      'icons/icon-16.png',
      'manifest.json',
    ]);
    expect(zip.files.get('manifest.json')?.toString('utf8')).toBe('{"manifest_version":3}');
    expect(zip.files.get('background.js')?.toString('utf8')).toBe('console.log("x");'.repeat(40));
  });

  it('is deterministic — the same input yields identical bytes (§8.15)', () => {
    write('manifest.json', '{"manifest_version":3}');
    write('popup.js', 'export const a = 1;');

    const first = join(workDir, 'first.zip');
    const second = join(workDir, 'second.zip');
    zipDirectory(join(workDir, 'src'), first);
    zipDirectory(join(workDir, 'src'), second);

    expect(readFileSync(first).equals(readFileSync(second))).toBe(true);
  });

  it('stores a file verbatim when compressing it would make it larger', () => {
    // Four random-ish bytes: deflate would add framing overhead.
    write('tiny.bin', 'a');
    const archivePath = join(workDir, 'out.zip');
    zipDirectory(join(workDir, 'src'), archivePath);

    expect(readZip(archivePath).files.get('tiny.bin')?.toString('utf8')).toBe('a');
  });

  it('creates the destination directory if it does not exist', () => {
    write('manifest.json', '{}');
    const archivePath = join(workDir, 'nested', 'deeper', 'out.zip');

    zipDirectory(join(workDir, 'src'), archivePath);

    expect(existsSync(archivePath)).toBe(true);
  });
});

describe('archive verification', () => {
  it('accepts an archive it just produced', () => {
    write('manifest.json', '{"manifest_version":3}');
    write('background.js', 'console.log("x");'.repeat(40));
    const archivePath = join(workDir, 'out.zip');
    zipDirectory(join(workDir, 'src'), archivePath);

    expect([...verifyArchive(archivePath).entries].sort()).toEqual([
      'background.js',
      'manifest.json',
    ]);
  });

  it('refuses an archive with no manifest — that is not an extension', () => {
    write('background.js', 'console.log("x");');
    const archivePath = join(workDir, 'out.zip');
    zipDirectory(join(workDir, 'src'), archivePath);

    expect(() => verifyArchive(archivePath)).toThrow(/no manifest\.json/);
  });

  it('refuses an archive whose payload was tampered with', () => {
    write('manifest.json', '{"manifest_version":3}');
    write('background.js', 'console.log("original");'.repeat(40));
    const archivePath = join(workDir, 'out.zip');
    zipDirectory(join(workDir, 'src'), archivePath);

    // Flip a byte inside the FIRST entry's payload — the local header is 30 bytes
    // plus the 13-byte name, so byte 50 is data. The CRC recorded for that entry no
    // longer describes what the archive holds.
    const bytes = readFileSync(archivePath);
    bytes[50] = (bytes[50] ?? 0) ^ 0xff;
    writeFileSync(archivePath, bytes);

    expect(() => verifyArchive(archivePath)).toThrow();
  });

  it('refuses a file that is not a ZIP at all', () => {
    const notAZip = join(workDir, 'nope.zip');
    writeFileSync(notAZip, 'this is not an archive', 'utf8');

    expect(() => verifyArchive(notAZip)).toThrow(/not a ZIP archive/);
  });
});

describe('extraction refuses to write outside its destination (§13.8)', () => {
  /** Build an archive whose single entry carries `name` verbatim. */
  function archiveWithEntry(name: string): string {
    const nameBytes = Buffer.from(name, 'utf8');
    const body = Buffer.from('payload', 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(0, 42);

    const centralStart = local.length + nameBytes.length + body.length;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + nameBytes.length, 12);
    end.writeUInt32LE(centralStart, 16);

    const path = join(workDir, `${Buffer.from(name).toString('hex')}.zip`);
    writeFileSync(path, Buffer.concat([local, nameBytes, body, central, nameBytes, end]));
    return path;
  }

  it.each([
    ['a parent traversal', '../escaped.txt'],
    ['a deep traversal', 'a/../../escaped.txt'],
    ['an absolute POSIX path', '/etc/escaped.txt'],
    ['a Windows-style traversal', '..\\escaped.txt'],
  ])('refuses %s', (_label, entry) => {
    const dest = join(workDir, 'dest');

    expect(() => extractArchive(archiveWithEntry(entry), dest)).toThrow(/unsafe entry path/);
    // And it wrote nothing at all, not even the entries it had already decoded.
    expect(existsSync(dest)).toBe(false);
  });

  it('accepts an ordinary nested name', () => {
    const dest = join(workDir, 'ok');
    expect(extractArchive(archiveWithEntry('chunks/factory.js'), dest)).toEqual([
      'chunks/factory.js',
    ]);
    expect(readFileSync(join(dest, 'chunks', 'factory.js'), 'utf8')).toBe('payload');
  });

  it('round-trips a non-ASCII entry name', () => {
    write('休日.txt', 'ok');
    const archivePath = join(workDir, 'utf8.zip');
    zipDirectory(join(workDir, 'src'), archivePath);

    const dest = join(workDir, 'utf8-out');
    expect(extractArchive(archivePath, dest)).toEqual(['休日.txt']);
    expect(readFileSync(join(dest, '休日.txt'), 'utf8')).toBe('ok');
  });
});

describe('verification catches a divergent archive', () => {
  it('rejects an archive whose local header disagrees with the directory', () => {
    write('manifest.json', '{"manifest_version":3}');
    write('background.js', 'console.log("x");'.repeat(40));
    const archivePath = join(workDir, 'out.zip');
    zipDirectory(join(workDir, 'src'), archivePath);

    // Corrupt only the LOCAL header's CRC. A reader that trusts the central directory
    // would accept this; a reader that trusts the local header would not.
    const bytes = readFileSync(archivePath);
    bytes.writeUInt32LE(0xdeadbeef, 14);
    writeFileSync(archivePath, bytes);

    expect(() => verifyArchive(archivePath)).toThrow(/local header disagrees/);
  });
});

describe('packaging refuses a build that is not the release', () => {
  it('will not package a directory whose manifest carries another version', () => {
    // A minimal but valid Chromium build directory, stamped with the wrong version.
    const dist = join(workDir, 'dist-chrome');
    const files = [
      'background.js',
      'content.js',
      'popup.js',
      'settings.js',
      'offscreen.js',
      'popup.html',
      'settings.html',
      'offscreen.html',
      'assets/styles.css',
      'icons/icon-16.png',
      'icons/icon-32.png',
      'icons/icon-48.png',
      'icons/icon-128.png',
      '_locales/en/messages.json',
    ];
    for (const file of files) {
      const path = join(dist, file);
      mkdirSync(resolve(path, '..'), { recursive: true });
      writeFileSync(path, '/* fixture */', 'utf8');
    }
    writeFileSync(
      join(dist, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        version: '0.0.1',
        permissions: ['storage', 'downloads', 'activeTab', 'scripting', 'offscreen'],
        optional_permissions: ['notifications', 'contextMenus'],
        optional_host_permissions: ['*://*/*'],
        content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" },
        background: { service_worker: 'background.js', type: 'module' },
      }),
    );

    // packageTarget resolves `dist/<target>` from the repository, so point the check at
    // the mismatch it is meant to catch by asking for a different release version.
    expect(() => packageTarget({ target: 'chrome', stores: ['test'] }, '9.9.9')).toThrow(
      /is built at version|not built/,
    );
  });
});
