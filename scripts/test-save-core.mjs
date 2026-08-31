// Identical commands run through an actual native binary and actual WASM.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtures = JSON.parse(readFileSync(new URL('../mine-core/tests/save-fixtures.json', import.meta.url), 'utf8'));
const wasm = createRequire(import.meta.url)('../output/playwright/save-core-node/mine_core.js');
const native = spawnSync('cargo', ['run', '--quiet', '-p', 'mine-core', '--bin', 'core-fixture', '--locked'], {
  cwd: root, input: fixtures.map(test => JSON.stringify(test.command)).join('\n') + '\n', encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
});
if (native.error) throw native.error;
if (native.status !== 0) throw new Error(native.stderr);
const replies = native.stdout.trim().split('\n').map(line => JSON.parse(line));
assert.equal(replies.length, fixtures.length);
for (const [index, test] of fixtures.entries()) {
  const browser = JSON.parse(wasm.execute_json(JSON.stringify(test.command)));
  assert.deepEqual(browser, replies[index], `${test.name}: native/WASM drift`);
  if (test.expected !== undefined) assert.deepEqual(browser, test.expected, test.name);
  if (test.name.includes('rejected') || test.name.startsWith('invalid')) assert.equal(browser.ok, false, test.name);
  if (test.markdownIncludes) {
    assert.equal(browser.ok, true, test.name);
    assert.ok(browser.value.markdown.includes(test.markdownIncludes), test.name);
  }
  if (test.markdownExcludes) {
    for (const text of test.markdownExcludes) assert.ok(!browser.value.markdown.includes(text), test.name);
  }
}
console.log(`${fixtures.length} native/WASM save fixtures passed`);
