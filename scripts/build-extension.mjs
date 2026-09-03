import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { replaceExtensionPayload } from './clipper-extension-payload.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'extension');
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(process.execPath, ['scripts/build-save-core.mjs']);
// Vite's extension output sits outside its popup root, so Vite deliberately
// retains old files. Clear only this generated directory before both bundles.
rmSync(join(source, 'dist'), { recursive: true, force: true });
run('bunx', ['vite', 'build', '--config', 'vite.extension.config.ts']);
run('bunx', ['vite', 'build', '--config', 'vite.overlay.config.ts']);
cpSync(join(root, 'public/fonts'), join(source, 'dist/fonts'), { recursive: true });
const safari = join(root, 'safari-extension/Local Arena Clipper/Local Arena Clipper Extension/Resources');
// Generated copies only: Safari consumes the same adapter/WASM, not a fork.
for (const name of ['dist', 'generated/save-core']) {
  rmSync(join(safari, name), { recursive: true, force: true });
  cpSync(join(source, name), join(safari, name), { recursive: true });
}
for (const name of ['manifest.json', 'background.js', 'content.js']) cpSync(join(source, name), join(safari, name));
mkdirSync(join(safari, 'lib'), { recursive: true });
for (const name of readdirSync(join(source, 'lib'))) {
  if (name.endsWith('.js') && !name.includes('.test.')) cpSync(join(source, 'lib', name), join(safari, 'lib', name));
}
const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
if (!manifest.content_security_policy.extension_pages.includes("'wasm-unsafe-eval'")) throw new Error('WASM CSP missing');
const payload = join(root, 'build/clipper-extension');
const extensionId = replaceExtensionPayload(source, payload);
console.log(`Extension payload ${extensionId}: ${payload}`);
if (process.argv.includes('--pack')) {
  mkdirSync(join(root, 'build'), { recursive: true });
  const archive = join(root, 'build/mine-clipper.zip');
  rmSync(archive, { force: true });
  run('zip', ['-qr', archive, 'manifest.json', 'background.js', 'content.js', 'dist', 'lib', 'icons', 'generated/save-core',
    '-x', '*.DS_Store', '*.test.*'], source);
  console.log(`Extension package: ${archive}`);
}
