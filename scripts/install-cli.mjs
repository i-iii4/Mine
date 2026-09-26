import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
function run(execute, command, args, root, capture = false) {
  const result = execute(command, args, { cwd: root, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `CLI preparation failed: ${command} (${result.status})`);
  return result;
}
// No user-path writes here: a single shared Rust owner validates and publishes.
export function installDeveloperCli(argv = [], options = {}) {
  if (argv.length) throw new Error('The developer CLI installer accepts no destination or downgrade override');
  if ((options.platform ?? process.platform) !== 'darwin') throw new Error('Managed CLI installation currently supports macOS only');
  const root = options.projectRoot ?? projectRoot;
  const execute = options.execute ?? spawnSync;
  run(execute, 'cargo', ['build', '-p', 'mine', '--release', '--bin', 'mine-cli', '--features', 'desktop,tooling', '--locked'], root);
  const metadata = run(execute, 'cargo', ['metadata', '--format-version', '1', '--no-deps', '--locked'], root, true);
  const directory = JSON.parse(metadata.stdout).target_directory;
  if (typeof directory !== 'string' || !directory.startsWith('/')) throw new Error('Cargo returned no absolute target directory');
  run(execute, 'cargo', ['run', '-p', 'mine', '--release', '--bin', 'cli-runtime-install', '--features', 'desktop,tooling', '--locked', '--',
    '--source', join(directory, 'release/mine-cli')], root);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { installDeveloperCli(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
