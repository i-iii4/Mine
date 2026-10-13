import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const EXTENSION_PAYLOAD_ENTRIES = [
  'manifest.json',
  'background.js',
  'content.js',
  'dist',
  'generated/save-core',
  'icons',
  'lib',
];

export function extensionIdFromManifest(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (typeof manifest.key !== 'string' || manifest.key.length === 0) {
    throw new Error(`Extension key is missing from ${manifestPath}`);
  }
  return createHash('sha256')
    .update(Buffer.from(manifest.key, 'base64'))
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + Number.parseInt(digit, 16)));
}

// Chromium keeps the background registered across browser restarts. It
// registers it again only when the manifest version differs from the
// registered one, and a registration whose script address did not change
// keeps the old script (SPEC_CLIPPER.md, К4). So every build gets its own
// version and its own worker file: a wrapper that only imports background.js,
// which stays byte for byte the source and its Safari mirror.
export const WORKER_WRAPPER_SOURCE = 'importScripts("background.js");\n';
const VERSION_PATTERN = /^(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){0,3}$/;

/** The version of a build made at `date`: UTC year, month and day, hour and
 *  minute, second and millisecond. A later build has a greater version, two
 *  builds of one commit included. */
export function extensionBuildVersion(date = new Date()) {
  const version = [
    date.getUTCFullYear(),
    (date.getUTCMonth() + 1) * 100 + date.getUTCDate(),
    date.getUTCHours() * 100 + date.getUTCMinutes(),
    date.getUTCSeconds() * 1000 + date.getUTCMilliseconds(),
  ].join('.');
  if (!validExtensionVersion(version)) throw new Error(`No extension version for ${date.toISOString()}`);
  return version;
}

/** One to four dot-separated integers, each from 0 to 65535, without leading
 *  zeros: a version Chromium accepts in a manifest. */
export function validExtensionVersion(version) {
  return typeof version === 'string' && VERSION_PATTERN.test(version)
    && version.split('.').every(part => Number(part) <= 65535);
}

export function workerFileName(version) {
  return `worker-${version}.js`;
}

/** Give the payload at `root` the build `version`: its own manifest version
 *  and its own worker wrapper, which replaces the wrapper it had. Returns the
 *  wrapper's file name. */
export function stampExtensionBuild(root, version) {
  if (!validExtensionVersion(version)) throw new Error(`Invalid extension version: ${version}`);
  const manifestPath = join(root, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const previous = manifest.background?.service_worker;
  if (previous !== 'background.js') {
    if (previous !== workerFileName(manifest.version)) throw new Error(`Unexpected extension worker in ${manifestPath}: ${previous}`);
    rmSync(join(root, previous), { force: true });
  }
  const worker = workerFileName(version);
  writeFileSync(join(root, worker), WORKER_WRAPPER_SOURCE);
  manifest.version = version;
  manifest.background = { ...manifest.background, service_worker: worker };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return worker;
}

function copyPayload(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of EXTENSION_PAYLOAD_ENTRIES) {
    const sourcePath = join(source, entry);
    if (!existsSync(sourcePath)) {
      throw new Error(`Extension payload is incomplete: ${sourcePath} is missing`);
    }
    cpSync(sourcePath, join(destination, entry), {
      recursive: true,
      filter: path => !basename(path).includes('.test.'),
    });
  }
}

/** Replace the payload at `destination` with the files of `source`, stamped
 *  as the build `version` (`stampExtensionBuild`). */
export function replaceExtensionPayload(source, destination, version) {
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  const transaction = join(parent, `.clipper-extension-${randomUUID()}`);
  const staged = join(transaction, 'new');
  const previous = join(transaction, 'previous');
  mkdirSync(transaction);
  try {
    copyPayload(source, staged);
    stampExtensionBuild(staged, version);
    const expectedId = extensionIdFromManifest(join(source, 'manifest.json'));
    const stagedId = extensionIdFromManifest(join(staged, 'manifest.json'));
    if (stagedId !== expectedId) {
      throw new Error(`Staged extension identity changed from ${expectedId} to ${stagedId}`);
    }
    if (existsSync(destination)) renameSync(destination, previous);
    try {
      renameSync(staged, destination);
    } catch (error) {
      if (existsSync(previous)) renameSync(previous, destination);
      throw error;
    }
    rmSync(previous, { recursive: true, force: true });
    return expectedId;
  } finally {
    rmSync(transaction, { recursive: true, force: true });
  }
}
