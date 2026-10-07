import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { pyinstallerExtractedEntries, verifyBundleBinaries } from './verify-bundle-binaries.mjs';

const MACHO = Buffer.from('cffaedfe', 'hex');

/** A Mach-O stand-in carrying a PyInstaller archive whose table lists `entries`
 *  as [type, name] pairs, laid out as PyInstaller writes it. */
function withArchive(entries) {
  const data = Buffer.from('payload');
  const toc = Buffer.concat(entries.map(([type, name]) => {
    const raw = Buffer.from(`${name}\0`);
    const length = 18 + raw.length + ((16 - ((18 + raw.length) % 16)) % 16);
    const entry = Buffer.alloc(length);
    entry.writeUInt32BE(length, 0);
    entry.writeUInt32BE(0, 4);
    entry.writeUInt32BE(data.length, 8);
    entry.writeUInt32BE(data.length, 12);
    entry[16] = 0;
    entry[17] = type.charCodeAt(0);
    raw.copy(entry, 18);
    return entry;
  }));
  const cookie = Buffer.alloc(88);
  Buffer.from([0x4d, 0x45, 0x49, 0x0c, 0x0b, 0x0a, 0x0b, 0x0e]).copy(cookie, 0);
  cookie.writeUInt32BE(data.length + toc.length + 88, 8);
  cookie.writeUInt32BE(data.length, 12);
  cookie.writeUInt32BE(toc.length, 16);
  cookie.writeUInt32BE(314, 20);
  return Buffer.concat([MACHO, Buffer.from('launcher code'), data, toc, cookie]);
}

const ONE_FILE = withArchive([['m', 'struct'], ['s', 'pyiboot01_bootstrap'], ['b', 'Python'], ['x', 'base_library.zip'], ['n', 'Python.framework/Python'], ['z', 'PYZ.pyz']]);
const UNPACKED_LAUNCHER = withArchive([['m', 'struct'], ['s', 'pyiboot01_bootstrap'], ['o', 'pyi-contents-directory _internal'], ['z', 'PYZ.pyz']]);

test('a one-file build is told from the launcher of an unpacked build', () => {
  assert.deepEqual(pyinstallerExtractedEntries(ONE_FILE), ['Python', 'base_library.zip', 'Python.framework/Python']);
  assert.deepEqual(pyinstallerExtractedEntries(UNPACKED_LAUNCHER), []);
  assert.equal(pyinstallerExtractedEntries(Buffer.concat([MACHO, Buffer.from('plain code')])), null);
  // A damaged table counts against the file.
  const damaged = Buffer.from(ONE_FILE);
  damaged.writeUInt32BE(1, damaged.length - 88 + 16);
  assert.notDeepEqual(pyinstallerExtractedEntries(damaged), []);
});

test('the staged unpacked yt-dlp passes the one-file rule', (context) => {
  const launcher = fileURLToPath(new URL('../src-tauri/binaries/yt-dlp-onedir/yt-dlp', import.meta.url));
  if (!existsSync(launcher)) return context.skip('yt-dlp is not staged (bun run fetch:ytdlp)');
  assert.deepEqual(pyinstallerExtractedEntries(readFileSync(launcher)), []);
});

function bundle({ ytdlpLauncher = UNPACKED_LAUNCHER, extra } = {}) {
  const root = join(mkdtempSync(join(tmpdir(), 'mine-bundle-binaries-')), 'Mine.app');
  const ytdlp = join(root, 'Contents/Resources/binaries/yt-dlp-onedir');
  mkdirSync(join(root, 'Contents/MacOS'), { recursive: true });
  mkdirSync(join(ytdlp, '_internal'), { recursive: true });
  writeFileSync(join(root, 'Contents/MacOS/mine'), Buffer.concat([MACHO, Buffer.from('app')]));
  writeFileSync(join(ytdlp, 'yt-dlp'), ytdlpLauncher);
  writeFileSync(join(ytdlp, '_internal/Python'), Buffer.concat([MACHO, Buffer.from('python')]));
  writeFileSync(join(root, 'Contents/Resources/readme.txt'), 'not code');
  extra?.(root, ytdlp);
  return root;
}
const signed = () => ({ status: 0, stdout: '', stderr: '' });

test('a signed bundle without one-file builds passes and every Mach-O is checked', () => {
  const root = bundle();
  const checked = [];
  const report = verifyBundleBinaries(root, { execute: (command, args) => { checked.push(args.at(-1)); return signed(); } });
  assert.equal(report.machO, 3);
  assert.equal(checked.length, 3);
  assert.ok(checked.every((path) => path.startsWith(root)));
});

test('a one-file build anywhere in the bundle stops the build', () => {
  const root = bundle({ ytdlpLauncher: ONE_FILE });
  assert.throws(() => verifyBundleBinaries(root, { execute: signed }), /self-extracting PyInstaller one-file build: Contents\/Resources\/binaries\/yt-dlp-onedir\/yt-dlp/);
});

test('an unsigned file, a symlink in yt-dlp or a missing launcher stops the build', () => {
  assert.throws(() => verifyBundleBinaries(bundle(), {
    execute: (command, args) => args.at(-1).endsWith('/Python') ? { status: 1, stderr: 'code object is not signed at all' } : signed(),
  }), /unsigned or invalid signature: .*_internal\/Python: code object is not signed at all/);
  assert.throws(() => verifyBundleBinaries(bundle({ extra: (root, ytdlp) => symlinkSync('Python', join(ytdlp, '_internal/Link')) }), { execute: signed }),
    /yt-dlp holds a symlink/);
  assert.throws(() => verifyBundleBinaries(bundle({ extra: (root, ytdlp) => unlinkSync(join(ytdlp, 'yt-dlp')) }), { execute: signed }),
    /yt-dlp launcher is missing/);
});
