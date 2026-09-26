import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { installDeveloperCli } from './install-cli.mjs';

test('CLI preparation delegates every user-path write to the shared owner without an extension build', () => {
  const calls = [];
  installDeveloperCli([], { platform: 'darwin', projectRoot: '/fixture/project', execute(command, args, options) {
    calls.push({ command, args, options });
    return { status: 0, stdout: args[0] === 'metadata' ? JSON.stringify({ target_directory: '/fixture/target' }) : '' };
  } });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].command, 'cargo'); assert.ok(calls[0].args.includes('mine-cli'));
  assert.deepEqual(calls[2].args.slice(-3), ['--', '--source', '/fixture/target/release/mine-cli']);
  assert.ok(calls[2].args.includes('cli-runtime-install'));
  assert.ok(calls.every(call => !call.args.some(argument => argument.includes('extension'))));
  const wrapper = readFileSync(new URL('./install-cli.sh', import.meta.url), 'utf8');
  assert.ok(!wrapper.includes('install -m')); assert.ok(!wrapper.includes('mkdir -p')); assert.ok(wrapper.includes('exec node'));
});
test('CLI preparation does not execute after invalid inputs or failed compilation', () => {
  let calls = 0;
  const execute = () => { calls++; return { status: 7 }; };
  assert.throws(() => installDeveloperCli(['--force'], { platform: 'darwin', execute }), /accepts no/);
  assert.throws(() => installDeveloperCli([], { platform: 'linux', execute }), /macOS/);
  assert.equal(calls, 0);
  assert.throws(() => installDeveloperCli([], { platform: 'darwin', execute }), /failed/);
  assert.equal(calls, 1);
});
