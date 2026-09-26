import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntimeManifest, probeNativeHost } from './build-clipper-runtime-manifest.mjs';

const MACHO_MAGIC = new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
function run(execute, command, args) {
  const result = execute(command, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Bundle finalization failed: ${command}: ${result.error?.message ?? result.stderr ?? result.status}`);
  return result.stdout ?? '';
}
function macho(path) {
  const descriptor = openSync(path, 'r');
  try { const bytes = Buffer.alloc(4); return readSync(descriptor, bytes, 0, 4, 0) === 4 && MACHO_MAGIC.has(bytes.toString('hex')); }
  finally { closeSync(descriptor); }
}
function nestedCode(bundle, main) {
  const files = [], bundles = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink() || entry.name === '_CodeSignature') continue;
      if (entry.isDirectory()) {
        visit(path);
        if (/\.(app|framework|xpc|appex)$/.test(entry.name)) bundles.push(path);
      } else if (entry.isFile() && path !== main && macho(path)) files.push(path);
    }
  }
  visit(bundle);
  return [...files, ...bundles];
}
function persistJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, 'wx', 0o644);
  try { writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  renameSync(temporary, path);
  const parent = openSync(dirname(path), 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

/** Local ad-hoc artifact only. Public Developer ID signing follows the same order. */
export function finalizeLocalBundle(bundle, options = {}) {
  if ((options.platform ?? process.platform) !== 'darwin') throw new Error('Local bundle finalization requires macOS');
  bundle = resolve(bundle);
  if (!bundle.endsWith('.app') || !lstatSync(bundle).isDirectory()) throw new Error('Expected a real app bundle directory');
  const execute = options.execute ?? spawnSync;
  const info = JSON.parse(run(execute, '/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(bundle, 'Contents/Info.plist')]));
  if (typeof info.CFBundleExecutable !== 'string' || basename(info.CFBundleExecutable) !== info.CFBundleExecutable
      || ['.', '..'].includes(info.CFBundleExecutable) || typeof info.CFBundleShortVersionString !== 'string') {
    throw new Error('Bundle executable or version is invalid');
  }
  const main = join(bundle, 'Contents/MacOS', info.CFBundleExecutable);
  if (!macho(main)) throw new Error('Bundle main executable is not Mach-O');
  const nested = nestedCode(bundle, main);
  for (const path of nested) run(execute, '/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', path]);

  const nativeHost = join(bundle, 'Contents/MacOS/native-host');
  const extension = join(bundle, 'Contents/Resources/clipper-extension');
  const ytdlp = join(bundle, 'Contents/Resources/binaries/yt-dlp');
  const identity = (options.probe ?? probeNativeHost)(nativeHost, info.CFBundleShortVersionString);
  const componentInputs = { appVersion: info.CFBundleShortVersionString, buildProfile: options.buildProfile ?? 'release',
    nativeHost, nativeHostBuildId: identity.build_id, extension, ytdlp };
  const manifest = createRuntimeManifest(componentInputs);
  const manifestPath = join(bundle, 'Contents/Resources/clipper-runtime-manifest.json');
  persistJson(manifestPath, manifest);

  // Never deep-sign here: it would mutate the bytes just recorded in the manifest.
  run(execute, '/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', bundle]);
  run(execute, '/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const actual = createRuntimeManifest(componentInputs);
  const reopened = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (JSON.stringify(actual) !== JSON.stringify(manifest) || JSON.stringify(reopened) !== JSON.stringify(manifest)) {
    throw new Error('Signed bundle component bytes differ from its sealed runtime manifest');
  }
  const launched = (options.probe ?? probeNativeHost)(nativeHost, info.CFBundleShortVersionString);
  if (launched.build_id !== manifest.native_host_build_id) throw new Error('Signed helper launch identity differs from sealed manifest');
  return { bundle, signing: 'local-ad-hoc', signature_verified: true, runtime_verified: true,
    nested_signed: nested.length, manifest };
}

function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length !== 3 || arguments_[0] !== '--bundle' || arguments_[2] !== '--ad-hoc') {
    throw new Error('Usage: node scripts/finalize-local-bundle.mjs --bundle <local .app path> --ad-hoc');
  }
  const report = finalizeLocalBundle(arguments_[1]);
  console.log(JSON.stringify(report, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
