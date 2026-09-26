import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const resourceRoot = 'safari-extension/Local Arena Clipper/Local Arena Clipper Extension/Resources';
// Only these changed generated files receive contract coverage. No directory exemption.
export const SAFARI_MIRRORS = [
  'background.js',
  'lib/draftStore.js',
  'lib/saveProtocol.js',
  'lib/standaloneVault.js',
].map(path => ({ source: `extension/${path}`, mirror: `${resourceRoot}/${path}` }));

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
