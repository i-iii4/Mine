// Developer install. The shipped app performs the same registration at launch.
// No placeholder ID and no writes to the user's vault/configuration.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionIdFromManifest, replaceExtensionPayload } from './clipper-extension-payload.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'darwin') throw new Error('This installer targets the supported macOS browsers');
const id = extensionIdFromManifest(join(root, 'extension/manifest.json'));
if (process.argv[2] && process.argv[2] !== id) throw new Error(`This build uses extension ${id}; no custom ID is required`);
if (process.argv[3]) throw new Error('Choose a vault in Mine or the clipper; this installer never modifies vault configuration');
const extensionBuild = spawnSync(process.execPath, ['scripts/build-extension.mjs'], { cwd: root, stdio: 'inherit' });
if (extensionBuild.error) throw extensionBuild.error;
if (extensionBuild.status !== 0) process.exit(extensionBuild.status ?? 1);
const build = spawnSync('cargo', ['build', '-p', 'mine', '--bin', 'native-host', '--release', '--no-default-features', '--locked'], { cwd: root, stdio: 'inherit' });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
const metadata = spawnSync('cargo', ['metadata', '--format-version', '1', '--no-deps', '--locked'], { cwd: root, encoding: 'utf8' });
if (metadata.error || metadata.status !== 0) throw metadata.error ?? new Error(metadata.stderr);
const binary = join(JSON.parse(metadata.stdout).target_directory, 'release/native-host');
const destination = join(homedir(), 'Library/Application Support/com.mine.app/clipper/native-host');
function atomicCopy(source, target) {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  copyFileSync(source, temporary); chmodSync(temporary, 0o755); renameSync(temporary, target);
}
atomicCopy(binary, destination);
const installedExtension = join(dirname(destination), 'extension');
const installedId = replaceExtensionPayload(join(root, 'build/clipper-extension'), installedExtension);
if (installedId !== id) throw new Error(`Installed extension identity changed from ${id} to ${installedId}`);
const video = join(root, 'src-tauri/binaries/yt-dlp');
if (existsSync(video)) atomicCopy(video, join(dirname(destination), 'yt-dlp'));
const manifest = { name: 'com.localarena.clipper', description: 'Mine web clipper native messaging host',
  path: destination, type: 'stdio', allowed_origins: [`chrome-extension://${id}/`] };
for (const browser of ['Google/Chrome', 'Dia/User Data', 'Arc/User Data', 'Microsoft Edge', 'BraveSoftware/Brave-Browser']) {
  const data = join(homedir(), 'Library/Application Support', browser);
  if (!existsSync(data)) continue;
  const folder = join(data, 'NativeMessagingHosts'); mkdirSync(folder, { recursive: true });
  const target = join(folder, 'com.localarena.clipper.json');
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n'); renameSync(temporary, target);
  console.log(`Registered ${browser}: ${target}`);
}
console.log(`Installed ${destination}; load/reload extension ${id} from ${installedExtension}`);
