import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
export const SAFARI_RESOURCES = 'safari-extension/Local Arena Clipper/Local Arena Clipper Extension/Resources';

/**
 * The files scripts/build-extension.mjs copies one by one from extension/
 * into the Safari resources, by its own rule: the manifest, the background,
 * the content script and every library script that is not a test. Every one
 * of them is compared byte for byte; none is left out by a hand-kept list.
 * The folders the build copies whole (dist, generated/save-core) are build
 * output that Git does not keep.
 */
export function safariMirrors(root = repository) {
  const libraries = readdirSync(resolve(root, 'extension/lib'))
    .filter(name => name.endsWith('.js') && !name.includes('.test.')).sort().map(name => `lib/${name}`);
  return ['background.js', 'content.js', 'manifest.json', ...libraries]
    .map(path => ({ source: `extension/${path}`, mirror: `${SAFARI_RESOURCES}/${path}` }));
}

export const SAFARI_MIRRORS = safariMirrors();

export async function verifyExtensionMirrors(root = repository) {
  const evidence = [];
  for (const { source, mirror } of SAFARI_MIRRORS) {
    for (const path of [source, mirror]) {
      if (!(await lstat(resolve(root, path))).isFile()) throw new Error(`Mirror member must be a regular file: ${path}`);
    }
    const sourceBytes = await readFile(resolve(root, source));
    const mirrorBytes = await readFile(resolve(root, mirror));
    if (!sourceBytes.equals(mirrorBytes)) throw new Error(`Generated Safari resource differs from its extension source: ${mirror}`);
    evidence.push({ source, mirror, bytes: sourceBytes.length, sha256: createHash('sha256').update(sourceBytes).digest('hex') });
  }
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyExtensionMirrors().then(evidence => console.log(`Verified byte equality of ${evidence.length} exact Safari resource mirrors.`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
