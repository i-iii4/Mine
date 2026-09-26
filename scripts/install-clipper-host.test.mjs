import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { installDeveloperRuntime, root, validateDeveloperInstallArguments } from './install-clipper-host.mjs';

test('developer installation delegates all writes to the shared Rust installer', () => {
  const calls = [];
  installDeveloperRuntime([], { platform: 'darwin', exists: () => true, execute(command, args) {
    calls.push({ command, args });
    return { status: 0, stdout: args[0] === 'metadata' ? JSON.stringify({ target_directory: '/test-only/cargo-target' }) : '' };
  } });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0].args, ['scripts/build-extension.mjs']);
  const owner = calls[3];
  assert.equal(owner.command, 'cargo');
  assert.ok(owner.args.includes('clipper-runtime-install'));
  assert.ok(owner.args.includes('/test-only/cargo-target/release/native-host'));
  assert.ok(owner.args.includes(join(root, 'build/clipper-extension')));
  assert.ok(owner.args.includes('--ytdlp'));
  assert.ok(owner.args.includes('desktop,tooling'));
});

test('JS entrypoint has no user-path installation or legacy registration algorithm', async () => {
  const source = await readFile(new URL('./install-clipper-host.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /copyFileSync|chmodSync|mkdirSync|renameSync|writeFileSync|replaceExtensionPayload/);
  assert.doesNotMatch(source, /homedir\(|NativeMessagingHosts|com\.localarena\.clipper|Library\/Application Support/);
  assert.match(source, /clipper-runtime-install/);
  const rust = await readFile(join(root, 'src-tauri/src/commands/clipper_setup.rs'), 'utf8');
  const owner = await readFile(join(root, 'src-tauri/src/runtime_installation.rs'), 'utf8');
  assert.match(owner, /MANAGED_RUNTIME_DIRECTORY[^\n]*"managed-v1"/);
  assert.match(rust, /MANAGED_RUNTIME_DIRECTORY/);
  assert.match(rust, /HOST_NAME[^\n]*"com\.mine\.clipper\.v1"/);
});

test('invalid arguments and earlier build failure prevent any installer invocation', () => {
  assert.throws(() => validateDeveloperInstallArguments([], { platform: 'linux' }), /macOS/);
  assert.throws(() => validateDeveloperInstallArguments(['custom-id'], { platform: 'darwin' }), /custom ID/);
  assert.throws(() => validateDeveloperInstallArguments(['id', '/a-space'], { platform: 'darwin' }), /never modifies/);
  const calls = [];
  assert.throws(() => installDeveloperRuntime([], { platform: 'darwin', execute(command, args) {
    calls.push({ command, args }); return { status: 9 };
  } }), /exit 9/);
  assert.equal(calls.length, 1);
});

test('missing optional media helper is omitted; malformed Cargo metadata fails closed', () => {
  const calls = [];
  installDeveloperRuntime([], { platform: 'darwin', exists: () => false, execute(command, args) {
    calls.push({ command, args }); return { status: 0, stdout: args[0] === 'metadata' ? JSON.stringify({ target_directory: '/test-only/target' }) : '' };
  } });
  assert.ok(!calls[3].args.includes('--ytdlp'));
  assert.throws(() => installDeveloperRuntime([], { platform: 'darwin', execute(_command, args) {
    return { status: 0, stdout: args[0] === 'metadata' ? '{}' : '' };
  } }), /absolute target directory/);
});
