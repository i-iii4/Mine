#!/usr/bin/env node
// Fetch the yt-dlp that ships inside the app bundle.
//
// Saving age-restricted video from X is a primary scenario, not an optional
// extra: the public syndication API refuses those clips to an anonymous caller,
// and yt-dlp is what gets them with the browser's own cookies. Asking a person
// who installed Mine from a store to run `brew install` first is not a path
// anyone walks, so the tool travels with the app.
//
// Downloaded rather than committed: it is an 80 MB third-party artifact with its
// own release cadence, and git is the wrong place for it.
//
// It also downloads YouTube videos for Download Media, and YouTube changes its
// player on its own schedule: a build older than a couple of months starts
// getting HTTP 403. Raising VERSION (and its SHA-256) replaces an already
// staged copy, because the staged version is recorded next to it.
//
// The vendor's unpacked build, not the one-file build (SPEC_ONBOARDING.md,
// О8.1): the one-file build unpacks its Python into $TMPDIR on every start, and
// a browser that quarantines what its processes write (Dia) taints that copy,
// so Gatekeeper refuses to load it. The unpacked build writes no code at all
// when it runs.

import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { YTDLP_DIRECTORY, YTDLP_EXECUTABLE } from './ytdlp-layout.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(HERE, '..');
const BINARIES = join(PROJECT, 'src-tauri', 'binaries');
export const DESTINATION = join(BINARIES, YTDLP_DIRECTORY);
// Outside the bundled directory: only the tool is bundled.
const VERSION_MARKER = join(BINARIES, '.yt-dlp-version');
// The one-file build an older fetch staged; it is never bundled again.
const LEGACY_ONE_FILE = join(BINARIES, 'yt-dlp');

// macOS universal unpacked build, pinned by version and by the SHA-256 the
// release lists in SHA2-256SUMS, so a rebuild is reproducible and a swapped
// asset is refused.
const VERSION = '2026.08.19';
const ARCHIVE_SHA256 = '07e54b0865303c864006925913bce2604f8ee8cc6f18699bac9c309f9328a6d8';
const URL = `https://github.com/yt-dlp/yt-dlp/releases/download/${VERSION}/yt-dlp_macos.zip`;
const MARKER = `${VERSION} ${ARCHIVE_SHA256}`;

/** The vendor's name for the executable inside the archive. */
const VENDOR_EXECUTABLE = 'yt-dlp_macos';

async function alreadyPresent() {
  try {
    const info = await stat(join(DESTINATION, YTDLP_EXECUTABLE));
    const staged = (await readFile(VERSION_MARKER, 'utf8')).trim();
    return info.isFile() && info.size > 1_000_000 && staged === MARKER;
  } catch {
    return false;
  }
}

async function sha256Of(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

async function walk(root, directory = root, entries = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    entries.push({ path, relative: relative(root, path), entry });
    if (entry.isDirectory()) await walk(root, path, entries);
  }
  return entries;
}

/**
 * Turn the unpacked vendor archive at `root` into the tree that ships.
 *
 * The archive spells the symlinks of `_internal/Python.framework` as copies:
 * the framework's `Python` three times and its `Info.plist` twice more. The
 * loader opens `_internal/Python`, and no library links against the framework
 * (checked with `otool` on 07.10.2026), so the framework is dropped, but only
 * after every file in it proved to be a byte copy of what stays: a version
 * laid out otherwise stops the fetch instead of shipping half a runtime.
 * The shipped tree has no symlinks: the clipper's package refuses them.
 */
export async function normalizeOnedir(root) {
  const vendorExecutable = join(root, VENDOR_EXECUTABLE);
  const internal = join(root, '_internal');
  const python = join(internal, 'Python');
  for (const required of [vendorExecutable, python]) {
    const info = await lstat(required).catch(() => null);
    if (!info?.isFile()) throw new Error(`unexpected yt-dlp layout: ${relative(root, required)} is missing`);
  }
  const framework = join(internal, 'Python.framework');
  const frameworkInfo = await lstat(framework).catch(() => null);
  if (frameworkInfo) {
    if (!frameworkInfo.isDirectory()) throw new Error('unexpected yt-dlp layout: Python.framework is not a directory');
    const pythonBytes = await readFile(python);
    let plist = null;
    for (const { path, relative: inside, entry } of await walk(framework)) {
      if (entry.isDirectory()) continue;
      if (!entry.isFile()) throw new Error(`unexpected yt-dlp layout: Python.framework/${inside} is not a file`);
      const bytes = await readFile(path);
      if (entry.name === 'Python') {
        if (!bytes.equals(pythonBytes)) throw new Error(`unexpected yt-dlp layout: Python.framework/${inside} differs from _internal/Python`);
      } else if (entry.name === 'Info.plist') {
        plist ??= bytes;
        if (!bytes.equals(plist)) throw new Error(`unexpected yt-dlp layout: Python.framework/${inside} differs from its copies`);
      } else {
        throw new Error(`unexpected yt-dlp layout: Python.framework/${inside} has no kept counterpart`);
      }
    }
    await rm(framework, { recursive: true });
  }
  for (const { relative: inside, entry } of await walk(root)) {
    if (entry.isSymbolicLink()) throw new Error(`unexpected yt-dlp layout: ${inside} is a symlink`);
  }
  await rename(vendorExecutable, join(root, YTDLP_EXECUTABLE));
  await chmod(join(root, YTDLP_EXECUTABLE), 0o755);
}

async function main() {
  if (await alreadyPresent()) {
    console.log(`yt-dlp ${VERSION} already staged at ${DESTINATION}`);
    return;
  }

  await mkdir(BINARIES, { recursive: true });
  const archive = join(BINARIES, `.yt-dlp-${randomUUID()}.zip`);
  const staging = join(BINARIES, `.yt-dlp-${randomUUID()}`);
  try {
    console.log(`Downloading yt-dlp ${VERSION} (unpacked build)…`);
    const response = await fetch(URL, { redirect: 'follow' });
    if (!response.ok || !response.body) {
      throw new Error(`failed to download yt-dlp: HTTP ${response.status}`);
    }
    await pipeline(response.body, createWriteStream(archive));
    const digest = await sha256Of(archive);
    if (digest !== ARCHIVE_SHA256) {
      throw new Error(`downloaded yt-dlp archive has SHA-256 ${digest}, expected ${ARCHIVE_SHA256}`);
    }

    await mkdir(staging);
    const unpacked = spawnSync('/usr/bin/ditto', ['-x', '-k', archive, staging], { encoding: 'utf8' });
    if (unpacked.status !== 0) {
      throw new Error(`failed to unpack yt-dlp: ${unpacked.stderr || unpacked.error?.message || unpacked.status}`);
    }
    await normalizeOnedir(staging);

    await rm(DESTINATION, { recursive: true, force: true });
    await rename(staging, DESTINATION);
    await rm(LEGACY_ONE_FILE, { force: true });
    await writeFile(VERSION_MARKER, `${MARKER}\n`);
    const size = (await stat(join(DESTINATION, YTDLP_EXECUTABLE))).size;
    console.log(`yt-dlp ${VERSION} staged at ${DESTINATION} (launcher ${Math.round(size / 1_000_000)} MB)`);
  } finally {
    await rm(archive, { force: true });
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
  });
}
