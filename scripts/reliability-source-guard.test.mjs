import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertSourceUnchanged, createFixture, guardCommand, sourceSnapshot } from './reliability-source-guard.mjs';

test('package source verification runs the actual external fixture reader, not an empty guard', async () => {
  const { scripts } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const [guard, reader] = scripts['test:reliability-source'].split(/\s--\s/);
  assert.equal(guard, 'node scripts/reliability-source-guard.mjs');
  assert.deepEqual(reader?.trim().split(/\s+/), [
    'cargo', 'test', '-p', 'mine', '--lib', '--no-default-features', '--locked', 'reliability_external_fixture',
  ], 'Source verification must execute its real reader against the synthetic fixture');
  assert.equal(scripts['test:reliability-index-source'], 'bun run test:reliability-source');
  const rust = await readFile(new URL('../src-tauri/src/storage/db.rs', import.meta.url), 'utf8');
  assert.match(rust, /fn reliability_external_fixture\s*\(/);
  assert.ok(rust.includes('MINE_RELIABILITY_SOURCE') && rust.includes('MINE_RELIABILITY_DERIVED'));
});

test('fixture covers real source bytes and distinguishes missing/cloud acceptance', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'mine-source-test-'));
  try {
    const fixture = await createFixture(temporary);
    const before = await sourceSnapshot(temporary);
    assert.equal(before['A/Same.md'].length, 64);
    assert.notEqual(before['A/Same.md'], before['B/Same.md']);
    assert.equal(fixture.environmentCases[0].status, 'pending');
    assertSourceUnchanged(before, await sourceSnapshot(temporary));
    await writeFile(join(temporary, 'Plain note.md'), 'changed');
    assert.throws(() => assertSourceUnchanged(before, { ...before, 'Plain note.md': 'different' }), /Source paths or bytes changed/);
    assert.throws(() => assertSourceUnchanged(before, Object.fromEntries(Object.entries(before).filter(([path]) => path !== 'Plain note.md'))), /Plain note/);
    await rename(join(temporary, 'A/Same.md'), join(temporary, 'A/Renamed.md'));
    assert.throws(() => assertSourceUnchanged(before, { ...before, 'A/Renamed.md': before['A/Same.md'] }), /Renamed/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('real subprocess reads fixture and writes derived state without changing source', async () => {
  const report = await guardCommand(process.execPath, ['--input-type=module', '-e',
    "import {readFileSync,writeFileSync} from 'node:fs'; import {join} from 'node:path'; const note=readFileSync(join(process.env.MINE_RELIABILITY_SOURCE,'Plain note.md'),'utf8'); if(!note.includes('Ordinary Markdown')) process.exit(2); writeFileSync(join(process.env.MINE_RELIABILITY_DERIVED,'projection.json'),JSON.stringify({note}));"]);
  assert.equal(report.exitCode, 0);
  assert.deepEqual(report.before, report.after);
  assert.equal(report.scope, 'source-immutability-only');
});

test('real subprocess that edits or creates a source file fails closed', async () => {
  for (const file of ['Plain note.md', 'Extra.md']) {
    await assert.rejects(guardCommand(process.execPath, ['-e',
      `require('node:fs').writeFileSync(require('node:path').join(process.env.MINE_RELIABILITY_SOURCE,${JSON.stringify(file)}),'changed')`]), /Source paths or bytes changed/);
  }
  await assert.rejects(guardCommand(process.execPath, ['-e',
    "require('node:fs').unlinkSync(require('node:path').join(process.env.MINE_RELIABILITY_SOURCE,'Plain note.md'))"]), /Source paths or bytes changed/);
});

test('reader failures and omitted command are never successful evidence', async () => {
  await assert.rejects(guardCommand(), /actual reader/);
  await assert.rejects(guardCommand(process.execPath, ['-e', 'process.exit(17)']), /failed/);
  await assert.rejects(guardCommand('/nonexistent/mine-reader'), /failed/);
});
