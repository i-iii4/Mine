// Run a test command with a home of its own (SPEC_DEEP_AUDIT.md, Н12).
//
// A test of the clipper helper wrote its lines into the person's
// ~/Library/Logs/com.mine.app/native-host.log on 13.10.2026: the code under
// test kept its own guard (a test build has no journal), but a test run on
// the code before a fix, to see it fail, runs the code before that guard too.
// The guard of the whole run is its HOME: whatever the code under test writes
// under ~/Library lands in the run's folder, which goes when the run ends.
// Cargo and rustup keep the person's toolchain and caches: their homes are
// named explicitly before HOME moves.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { disposableAppHome } from './disposable-app-home.mjs';

/** The environment of a run in `run`: HOME inside it, the toolchain homes
 *  where they were. */
export function disposableTestEnvironment(run, env = process.env) {
  const realHome = env.HOME;
  if (!realHome) throw new Error('HOME is not set: the toolchain cannot be found');
  const { env: moved } = disposableAppHome(run, env);
  return {
    ...moved,
    CARGO_HOME: env.CARGO_HOME ?? join(realHome, '.cargo'),
    RUSTUP_HOME: env.RUSTUP_HOME ?? join(realHome, '.rustup'),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error('usage: node scripts/run-with-disposable-home.mjs <command> [arguments…]');
    process.exit(2);
  }
  const run = mkdtempSync(join(tmpdir(), 'mine-test-home-'));
  let status = 1;
  try {
    const result = spawnSync(command, args, { stdio: 'inherit', env: disposableTestEnvironment(run) });
    if (result.error) throw result.error;
    status = result.status ?? 1;
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
  process.exit(status);
}
