// SPEC_DEEP_AUDIT.md, Н12: the Rust tests run with a home of their own, so a
// test of the clipper helper, even one run on the code before a fix, writes
// its journal and app data into the run's folder, never into the person's
// ~/Library.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { disposableTestEnvironment } from './run-with-disposable-home.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const runner = join(root, 'scripts/run-with-disposable-home.mjs');

test('HOME moves into the run folder and the toolchain stays where it was', () => {
  const env = disposableTestEnvironment('/tmp/mine-run', { HOME: '/Users/someone', PATH: '/usr/bin' });
  assert.equal(env.HOME, '/tmp/mine-run/home');
  assert.equal(env.CARGO_HOME, '/Users/someone/.cargo');
  assert.equal(env.RUSTUP_HOME, '/Users/someone/.rustup');
  assert.equal(env.PATH, '/usr/bin');

  const named = disposableTestEnvironment('/tmp/mine-run', {
    HOME: '/Users/someone', CARGO_HOME: '/opt/cargo', RUSTUP_HOME: '/opt/rustup',
  });
  assert.equal(named.CARGO_HOME, '/opt/cargo');
  assert.equal(named.RUSTUP_HOME, '/opt/rustup');
});

test('a command writes under its own home, which goes with the run', () => {
  const marker = 'Library/Logs/com.mine.app/native-host.log';
  const result = spawnSync(process.execPath, [runner, '/bin/sh', '-c',
    `mkdir -p "$HOME/Library/Logs/com.mine.app" && echo line >> "$HOME/${marker}" && echo "$HOME"`], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const home = result.stdout.trim();
  assert.notEqual(home, process.env.HOME);
  assert.ok(!existsSync(home), 'the run folder outlived the run');
});

test('the exit status of the command is the runner\'s', () => {
  const result = spawnSync(process.execPath, [runner, '/bin/sh', '-c', 'exit 3']);
  assert.equal(result.status, 3);
});

test('the Rust tests run with a home of their own', () => {
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
  assert.match(scripts['test:rust'], /node scripts\/run-with-disposable-home\.mjs cargo test /);
});
