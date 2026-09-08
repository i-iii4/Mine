import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWED_EXECUTABLES = new Set(['Mine', 'mine', 'native-host']);

export function inspectBundle(appPath) {
  const macos = join(appPath, 'Contents/MacOS');
  const resources = join(appPath, 'Contents/Resources');
  const executables = readdirSync(macos).sort();
  const unexpectedExecutables = executables.filter((name) => !ALLOWED_EXECUTABLES.has(name));
  return {
    appPath,
    executables,
    unexpectedExecutables,
    runtimeManifest: join(resources, 'clipper-runtime-manifest.json'),
  };
}

export function assertBundleInventory(appPath) {
  const inventory = inspectBundle(appPath);
  assert.deepEqual(
    inventory.unexpectedExecutables,
    [],
    `unexpected GUI bundle executables: ${inventory.unexpectedExecutables.join(', ')}`,
  );
  assert.ok(
    existsSync(inventory.runtimeManifest),
    `missing clipper runtime manifest: ${inventory.runtimeManifest}`,
  );
  assert.ok(
    inventory.executables.includes('mine') || inventory.executables.includes('Mine'),
    `missing Mine GUI executable in ${appPath}`,
  );
  assert.ok(inventory.executables.includes('native-host'), `missing native-host in ${appPath}`);
  return inventory;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const appPath = resolve(process.argv[2] ?? 'target/release/bundle/macos/Mine.app');
  const inventory = assertBundleInventory(appPath);
  console.log(`${basename(appPath)} executables: ${inventory.executables.join(', ')}`);
}
