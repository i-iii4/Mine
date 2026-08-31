// Developer install. The shipped app performs the same registration at launch.
// No placeholder ID and no writes to the user's vault/configuration.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'darwin') throw new Error('This installer targets the supported macOS browsers');
const extension = JSON.parse(readFileSync(join(root, 'extension/manifest.json'), 'utf8'));
const id = createHash('sha256').update(Buffer.from(extension.key, 'base64')).digest('hex').slice(0, 32)
  .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
if (process.argv[2] && process.argv[2] !== id) throw new Error(`This build uses extension ${id}; no custom ID is required`);
if (process.argv[3]) throw new Error('Choose a vault in Mine or the clipper; this installer never modifies vault configuration');
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
console.log(`Installed ${destination}; load/reload extension ${id} from ${join(root, 'extension')}`);
