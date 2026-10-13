// SPEC_DEEP_AUDIT.md, Н12 and Е5.17: checks that run the clipper helper give
// it a home of their own, so its derived stores and save journals land in the
// run's folder, never in the person's
// ~/Library/Application Support/com.mine.app.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { disposableAppHome } from './disposable-app-home.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const helperRunners = ['scripts/clipper-native-lifecycle.mjs', 'scripts/native-capture-smoke.mjs'];

test('the disposable home lives in the run folder and the helper data under it', () => {
  const run = '/tmp/mine-check-run';
  const home = disposableAppHome(run, { HOME: '/Users/someone', PATH: '/usr/bin' });
  assert.equal(home.home, join(run, 'home'));
  assert.equal(home.appState, join(run, 'home', 'Library/Application Support/com.mine.app'));
  assert.equal(home.env.HOME, home.home);
  assert.equal(home.env.PATH, '/usr/bin');
});

test('scripts that run the helper never point it at the real app data', async () => {
  for (const script of helperRunners) {
    const text = await readFile(join(root, script), 'utf8');
    assert.match(text, /disposableAppHome\(/, `${script} gives the helper a home of its own`);
    assert.doesNotMatch(
      text,
      /process\.env\.HOME,\s*['"]Library\/Application Support\/com\.mine\.app/,
      `${script} reads the person's app data`,
    );
  }
});
