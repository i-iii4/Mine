// Development entrypoint only. Rust owns installation, locking, recovery,
// version ordering, retention and browser registration for every caller.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionIdFromManifest } from './clipper-extension-payload.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));

function run(execute, command, args, cwd, capture = false) {
  const result = execute(command, args, { cwd, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal) {
    throw new Error(`${command} failed: ${result.signal || result.stderr?.trim() || `exit ${result.status}`}`);
  }
  return result;
}

/** Validate the explicit developer invocation without changing any installation. */
export function validateDeveloperInstallArguments(argv, { projectRoot = root, platform = process.platform } = {}) {
  if (platform !== 'darwin') throw new Error('This installer targets the supported macOS browsers');
  const id = extensionIdFromManifest(join(projectRoot, 'extension/manifest.json'));
  if (argv.length > 1) throw new Error('Choose a space in Mine or the clipper; this installer never modifies space configuration');
  if (argv[0] && argv[0] !== id) throw new Error(`This build uses extension ${id}; a custom ID is not supported`);
  return id;
}

/** Build source artifacts, then delegate every installation write to the shared Rust owner. */
export function installDeveloperRuntime(argv = [], options = {}) {
  const projectRoot = options.projectRoot ?? root;
  validateDeveloperInstallArguments(argv, { projectRoot, platform: options.platform ?? process.platform });
  const execute = options.execute ?? spawnSync;
  run(execute, process.execPath, ['scripts/build-extension.mjs'], projectRoot);
  run(execute, 'cargo', ['build', '-p', 'mine', '--bin', 'native-host', '--release', '--no-default-features', '--locked'], projectRoot);
  const metadata = run(execute, 'cargo', ['metadata', '--format-version', '1', '--no-deps', '--locked'], projectRoot, true);
  const targetDirectory = JSON.parse(metadata.stdout).target_directory;
  if (typeof targetDirectory !== 'string' || !targetDirectory.startsWith('/')) throw new Error('Cargo returned no absolute target directory');
  const argumentsForOwner = ['run', '-p', 'mine', '--bin', 'clipper-runtime-install', '--release', '--features', 'desktop,tooling', '--locked', '--',
    '--host', join(targetDirectory, 'release/native-host'), '--extension', join(projectRoot, 'build/clipper-extension')];
  const video = join(projectRoot, 'src-tauri/binaries/yt-dlp');
  if ((options.exists ?? existsSync)(video)) argumentsForOwner.push('--ytdlp', video);
  run(execute, 'cargo', argumentsForOwner, projectRoot);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { installDeveloperRuntime(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
