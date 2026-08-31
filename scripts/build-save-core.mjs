// Build the same portable crate for the extension and real WASM parity tests.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = '0.2.120';
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const installed = spawnSync('wasm-bindgen', ['--version'], { encoding: 'utf8' });
if (installed.error || installed.stdout.trim() !== `wasm-bindgen ${version}`) {
  throw new Error(`Install matching tooling: cargo install wasm-bindgen-cli --version ${version} --locked`);
}
run('cargo', ['build', '-p', 'mine-core', '--lib', '--release', '--target', 'wasm32-unknown-unknown', '--locked']);
const binary = join(root, 'target/wasm32-unknown-unknown/release/mine_core.wasm');
run('wasm-bindgen', [binary, '--target', 'no-modules', '--out-dir', 'extension/generated/save-core', '--out-name', 'mine_core']);
if (process.argv.includes('--test-runtime')) {
  const output = join(root, 'output/playwright/save-core-node');
  mkdirSync(output, { recursive: true });
  run('wasm-bindgen', [binary, '--target', 'nodejs', '--out-dir', output, '--out-name', 'mine_core']);
  // Generated artifacts, not hand-written source. Scope CommonJS to this fixture runtime.
  writeFileSync(join(output, 'package.json'), JSON.stringify({ type: 'commonjs' }) + '\n');
}
