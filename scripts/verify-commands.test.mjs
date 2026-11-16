// AUDIT_CODE_QUALITY.md, О1: the combined commands run what they claim to.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createReach } from './test-reach.mjs';
import { BUILT_APP, NOT_RUN, VERIFY, isCheck, runBy, unexplainedChecks } from './verify-commands.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
const BROWSER_AUDITS = 'scripts/browser-audits.mjs';

test('every check of package.json is run by verify or verify:built-app, or has its reason', () => {
  assert.deepEqual(unexplainedChecks(scripts, createReach(root)), []);
});

test('the checks that need the built app are run by verify:built-app, and verify:release runs both', () => {
  const reach = createReach(root);
  for (const name of ['test:clipper-worker', 'test:clipper-native-release', 'test:native-shell', 'verify:bundle-binaries']) {
    assert.equal(runBy(reach, name), BUILT_APP, name);
  }
  assert.equal(reach.covers('verify:release', VERIFY), true);
  assert.equal(reach.covers('verify:release', BUILT_APP), true);
});

test('an audit taken out of browser-audits.mjs is a check nothing runs', () => {
  const source = readFileSync(join(root, BROWSER_AUDITS), 'utf8');
  const audits = [...source.matchAll(/runAudit\("(scripts\/[^"]+)"/g)].map(match => match[1]);
  assert.ok(audits.length > 0, 'browser-audits.mjs starts its audits with runAudit("scripts/…")');
  for (const audit of audits) {
    const names = Object.keys(scripts).filter(name => scripts[name] === `node ${audit}`);
    assert.ok(names.length > 0, `${audit} has a package.json command of its own`);
    const without = createReach(root, new Map([[BROWSER_AUDITS, source.replaceAll(`"${audit}"`, '""')]]));
    const problems = unexplainedChecks(scripts, without);
    for (const name of names) {
      assert.ok(problems.some(problem => problem.startsWith(`${name}: neither`)), `${name} is reported once ${audit} is not started`);
    }
  }
});

test('a check outside the combined commands needs a reason, and a reason goes stale', () => {
  const reach = { covers: (whole, name) => whole === VERIFY && name === 'test:inside' };
  const all = { verify: 'bun run test:inside', 'test:inside': 'node a.mjs', 'test:outside': 'node b.mjs', build: 'vite build' };
  assert.deepEqual(unexplainedChecks(all, reach, {}), [
    'verify: neither verify nor verify:built-app runs it, and it has no reason in NOT_RUN',
    'test:outside: neither verify nor verify:built-app runs it, and it has no reason in NOT_RUN',
  ]);
  assert.deepEqual(unexplainedChecks(all, reach, { verify: 'the command itself', 'test:outside': 'needs a person' }), []);
  assert.deepEqual(unexplainedChecks(all, reach, { verify: 'the command itself', 'test:outside': ' ' }).length, 1);
  assert.deepEqual(unexplainedChecks(all, reach, { verify: 'the command itself', 'test:outside': 'needs a person', 'test:inside': 'old', 'test:gone': 'old' }), [
    'test:inside: verify runs it, its reason in NOT_RUN is stale',
    'test:gone: named in NOT_RUN, absent from package.json',
  ]);
  assert.equal(isCheck('build'), false);
  assert.equal(isCheck('test'), true);
  assert.equal(isCheck('check:x'), true);
});

test('every reason is written out', () => {
  for (const [name, reason] of Object.entries(NOT_RUN)) assert.ok(reason.trim().length > 20, name);
});
