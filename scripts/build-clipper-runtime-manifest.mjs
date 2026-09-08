import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');

export function fileComponentManifest(path) {
  const bytes = readFileSync(path);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
}

function treeFiles(root, directory = root, files = []) {
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`runtime payload contains a symlink: ${path}`);
    }
    if (entry.isDirectory()) treeFiles(root, path, files);
    if (entry.isFile()) files.push(relative(root, path).replaceAll('\\', '/'));
  }
  return files;
}

export function treeComponentManifest(root) {
  const hash = createHash('sha256');
  let totalBytes = 0;
  const files = treeFiles(root);
  if (!files.includes('manifest.json')) {
    throw new Error(`extension payload has no manifest.json: ${root}`);
  }
  for (const relativePath of files) {
    const bytes = readFileSync(join(root, relativePath));
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(bytes.length));
    hash.update(relativePath);
    hash.update(Buffer.from([0]));
    hash.update(length);
    hash.update(bytes);
    totalBytes += bytes.length;
  }
  return { sha256: hash.digest('hex'), bytes: totalBytes };
}

export function createRuntimeManifest({ appVersion, buildProfile, nativeHost, extension, ytdlp }) {
  return {
    schema_version: 1,
    build_profile: buildProfile,
    app_version: appVersion,
    native_host: fileComponentManifest(nativeHost),
    extension: treeComponentManifest(extension),
    ytdlp: ytdlp ? fileComponentManifest(ytdlp) : null,
  };
}

function main() {
  const profile = process.env.TAURI_ENV_DEBUG === 'true' ? 'debug' : 'release';
  const cargoTarget = resolve(process.env.CARGO_TARGET_DIR ?? join(projectRoot, 'target'));
  const tauriConfig = JSON.parse(readFileSync(join(projectRoot, 'src-tauri/tauri.conf.json'), 'utf8'));
  const output = join(projectRoot, 'build/clipper-runtime-manifest.json');
  const manifest = createRuntimeManifest({
    appVersion: tauriConfig.version,
    buildProfile: profile,
    nativeHost: join(cargoTarget, profile, 'native-host'),
    extension: join(projectRoot, 'build/clipper-extension'),
    ytdlp: join(projectRoot, 'src-tauri/binaries/yt-dlp'),
  });
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(temporary, output);
  const size = statSync(output).size;
  console.log(`Generated ${output} (${size} bytes, ${profile})`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) main();
