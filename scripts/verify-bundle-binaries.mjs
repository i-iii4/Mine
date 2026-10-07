// Check the code a built Mine.app ships (SPEC_ONBOARDING.md, О8.2): every
// Mach-O file in the bundle is signed, none of them is a self-extracting
// PyInstaller one-file build, and the unpacked yt-dlp holds no symlinks.
//
// Why the one-file rule (07.10.2026): such a build unpacks its Python into
// $TMPDIR on every start. Launched from a browser that quarantines what its
// processes write (Dia), the unpacked copy is quarantined, and Gatekeeper
// refuses to load ad-hoc signed code from it: the clipper hung behind a
// "Python.framework is damaged" dialog. Code that ships unpacked and signed is
// never written at run time, so there is nothing for the quarantine to taint.
//
// The clipper's package is copied from the bundle and checked against the
// bundle's sealed manifest byte for byte, so a bundle that passes here ships a
// package that passes too.

import { spawnSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { YTDLP_DIRECTORY, YTDLP_EXECUTABLE } from './ytdlp-layout.mjs';

const MACHO_MAGIC = new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
/** PyInstaller's CArchive cookie: `MEI\014\013\012\013\016`, then the
 *  archive's length, its table of contents' offset and length, the Python
 *  version and the Python library's name: 88 bytes. */
const PYINSTALLER_COOKIE = Buffer.from([0x4d, 0x45, 0x49, 0x0c, 0x0b, 0x0a, 0x0b, 0x0e]);
const COOKIE_LENGTH = 88;
/** Entries the bootloader writes to disk before Python starts: binaries,
 *  data files, dependencies and symlinks. A one-file build has them; the
 *  launcher of an unpacked build carries only its scripts, modules, options
 *  and the PYZ (`m`, `M`, `s`, `o`, `z`, `Z`), read from memory. */
const EXTRACTED_TYPES = new Set(['b', 'x', 'd', 'n', 'l']);

function macho(path) {
  const descriptor = openSync(path, 'r');
  try {
    const bytes = Buffer.alloc(4);
    return readSync(descriptor, bytes, 0, 4, 0) === 4 && MACHO_MAGIC.has(bytes.toString('hex'));
  } finally {
    closeSync(descriptor);
  }
}

/**
 * The names a PyInstaller archive in `bytes` would extract to disk at start,
 * or `null` when the file carries no PyInstaller archive. A damaged table of
 * contents counts as extracting: the gate does not guess in favour of a file.
 */
export function pyinstallerExtractedEntries(bytes) {
  const cookie = bytes.lastIndexOf(PYINSTALLER_COOKIE);
  if (cookie < 0) return null;
  if (cookie + COOKIE_LENGTH > bytes.length) return ['<truncated archive cookie>'];
  const archiveLength = bytes.readUInt32BE(cookie + 8);
  const tocOffset = bytes.readUInt32BE(cookie + 12);
  const tocLength = bytes.readUInt32BE(cookie + 16);
  const archiveStart = cookie + COOKIE_LENGTH - archiveLength;
  const toc = archiveStart + tocOffset;
  if (archiveStart < 0 || toc < 0 || toc + tocLength > bytes.length) return ['<unreadable archive table>'];
  const extracted = [];
  let at = toc;
  while (at < toc + tocLength) {
    const entryLength = bytes.readUInt32BE(at);
    if (entryLength < 18 || at + entryLength > toc + tocLength) return [...extracted, '<unreadable archive entry>'];
    const type = String.fromCharCode(bytes[at + 17]);
    const name = bytes.subarray(at + 18, at + entryLength).toString('utf8').replace(/\0+$/, '');
    if (EXTRACTED_TYPES.has(type)) extracted.push(name);
    at += entryLength;
  }
  return extracted;
}

function walk(root, directory = root, found = { machO: [], symlinks: [] }) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) found.symlinks.push(path);
    else if (entry.isDirectory()) walk(root, path, found);
    else if (entry.isFile() && macho(path)) found.machO.push(path);
  }
  return found;
}

/** Check a built bundle; throws with every problem found, or reports what passed. */
export function verifyBundleBinaries(bundle, options = {}) {
  const execute = options.execute ?? spawnSync;
  bundle = resolve(bundle);
  if (!bundle.endsWith('.app') || !lstatSync(bundle).isDirectory()) throw new Error(`Expected an app bundle directory: ${bundle}`);
  const problems = [];
  const ytdlp = join(bundle, 'Contents/Resources/binaries', YTDLP_DIRECTORY);
  const launcher = join(ytdlp, YTDLP_EXECUTABLE);
  if (!lstatSync(launcher, { throwIfNoEntry: false })?.isFile()) problems.push(`yt-dlp launcher is missing: ${relative(bundle, launcher)}`);
  const { machO, symlinks } = walk(bundle);
  for (const link of symlinks) {
    if (link.startsWith(`${ytdlp}/`)) problems.push(`yt-dlp holds a symlink: ${relative(bundle, link)}`);
  }
  for (const path of machO) {
    const extracted = pyinstallerExtractedEntries(readFileSync(path));
    if (extracted && extracted.length > 0) {
      problems.push(`self-extracting PyInstaller one-file build: ${relative(bundle, path)} (unpacks ${extracted.slice(0, 3).join(', ')}${extracted.length > 3 ? ', …' : ''})`);
    }
    const signature = execute('/usr/bin/codesign', ['--verify', '--strict', path], { encoding: 'utf8', timeout: 30_000 });
    if (signature.error || signature.status !== 0) {
      problems.push(`unsigned or invalid signature: ${relative(bundle, path)}: ${(signature.stderr || signature.error?.message || signature.status).toString().trim()}`);
    }
  }
  if (problems.length > 0) throw new Error(`Bundle binaries check failed:\n${problems.map((line) => `- ${line}`).join('\n')}`);
  return { bundle, machO: machO.length, signed: machO.length, ytdlp: relative(bundle, launcher) };
}

function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length !== 2 || arguments_[0] !== '--bundle') {
    throw new Error('Usage: node scripts/verify-bundle-binaries.mjs --bundle <path to Mine.app>');
  }
  console.log(JSON.stringify(verifyBundleBinaries(arguments_[1]), null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
