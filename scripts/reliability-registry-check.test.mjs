import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ACCEPTANCE, PRINCIPLES, artifactDigest, automaticBaseNotice, changeBase, changedPaths, markdownHeadings, registryPath, repository, validateRegistry, verifyChangeCoverage, verifyModuleBoundaries, verifyRegistryFormat, verifyRelease } from './reliability-registry-check.mjs';
import { fixturePath, sha256 } from './reliability-source-guard.mjs';
import { createReach } from './test-reach.mjs';
import { SAFARI_MIRRORS } from './verify-extension-mirrors.mjs';

async function registry() { return JSON.parse(await readFile(registryPath, 'utf8')); }
// One reading of the sources for every check below.
const reach = createReach(repository);
const check = value => validateRegistry(value, repository, reach);
const INV_01 = 'SPEC_SYSTEM_RELIABILITY.md#### INV-01. Реестр проверок';

test('all eleven principles, 24 scenarios and four levels have executable owners', async () => {
  const value = await registry();
  await check(value);
  assert.equal(value.principles.length, PRINCIPLES.length);
  assert.equal(value.acceptance.length, ACCEPTANCE.length);
  assert.ok(value.acceptance.every(entry => entry.result === 'pending'));
});

test('missing, duplicated, unknown or skipped scenarios cannot satisfy release acceptance', async () => {
  for (const mutation of [
    value => value.acceptance.pop(),
    value => { value.acceptance[0].id = 'A02'; },
    value => { value.acceptance[0].id = 'A25'; },
    value => { value.acceptance[0].result = 'unknown'; },
    value => { value.principles[0].tests = []; },
    value => { value.levels[0].command = 'missing-command'; },
    value => { value.principles[0].requirement = 'PRINCIPLES.md#missing-heading'; },
    value => { value.acceptance[0].result = 'passed'; },
  ]) {
    const value = await registry(); mutation(value);
    await assert.rejects(check(value));
  }
  for (const result of ['pending', 'failed', 'skipped', 'flaky']) {
    const value = await registry(); value.acceptance[0].result = result;
    await assert.rejects(verifyRelease(value, undefined, { reach }), /Release blocked/);
  }
});

test('ordinary registry checks pass while the actual release CLI exits nonzero', () => {
  const execution = spawnSync(process.execPath, [fileURLToPath(new URL('./reliability-registry-check.mjs', import.meta.url)), '--release'], { encoding: 'utf8' });
  assert.equal(execution.status, 1);
  assert.match(execution.stderr, /Release blocked/);
  assert.match(execution.stderr, /A01/);
  assert.match(execution.stderr, /A24/);
});

// The reference used to be found anywhere in the file: the start of a
// heading, a heading of another level or a word passed (Е7.7).
test('a requirement names one whole heading line of its document', async () => {
  for (const requirement of ['PRINCIPLES.md#### 1.', 'PRINCIPLES.md## 1. Контракт первичен', 'PRINCIPLES.md#Контракт первичен',
    'PRINCIPLES.md#### 1. Контракт']) {
    const value = await registry();
    value.principles[0].requirement = requirement;
    await assert.rejects(check(value), /Requirement heading missing/, requirement);
    const coverage = await registry();
    coverage.changeCoverage[0].requirement = requirement;
    await assert.rejects(check(coverage), /Requirement heading missing/, requirement);
  }
  const value = await registry();
  value.principles[0].requirement = 'PRINCIPLES.md#### 1. Контракт первичен';
  await check(value);
  assert.deepEqual([...markdownHeadings('# Title\n```md\n## In code\n```\n## Section  \nText ## not\n')], ['# Title', '## Section']);
});

// The registry used to accept any path next to any existing test and any
// command, so a failing check was fixed by adding the path (Е7.7).
test('every change coverage claim holds: the command runs the test and the test executes the path', async () => {
  const frontend = value => value.changeCoverage.find(entry => entry.command === 'test:frontend');
  for (const [mutation, message] of [
    [value => { frontend(value).paths.push('scripts/fetch-ytdlp.mjs'); }, /no test of the entry imports, reads or launches scripts\/fetch-ytdlp\.mjs/],
    [value => { frontend(value).command = 'test:scripts'; }, /test:scripts does not run/],
    [value => { frontend(value).paths.push('src/'); }, /a directory would cover files no test touches: src\//],
    [value => { frontend(value).paths.push('src/no-such-module.ts'); }, /path does not exist: src\/no-such-module\.ts/],
    [value => { frontend(value).tests.push('src/no-such-module.test.ts'); }, /test does not exist: src\/no-such-module\.test\.ts/],
    [value => { frontend(value).command = 'no-such-script'; }, /no package\.json script no-such-script/],
    [value => { frontend(value).requirement = 'SPEC_SYSTEM_RELIABILITY.md#INV-01'; }, /Requirement heading missing/],
    [value => { frontend(value).paths = []; }, /no paths/],
    [value => { frontend(value).tests = []; }, /no tests/],
  ]) {
    const value = await registry();
    mutation(value);
    await assert.rejects(check(value), message);
  }
  const value = await registry();
  value.changeCoverage.push({ paths: ['scripts/test-reach.mjs'], requirement: INV_01, tests: ['scripts/test-reach.test.mjs'], command: 'test:reliability' });
  await check(value);
});

// The fixture used to pass by listing its case labels (Е7.8).
test('the reliability fixture is bound to a test that checks every required case in a branch of its own', async () => {
  const fixture = 'scripts/fixtures/reliability/source-v1.json';
  const unbind = (value, keep) => {
    for (const entry of value.changeCoverage) if (!keep(entry)) entry.paths = entry.paths.filter(path => path !== fixture);
    value.changeCoverage = value.changeCoverage.filter(entry => entry.paths.length > 0);
    return value;
  };
  // Read by a test that has no branch per case: the hash guard of the source.
  const readOnly = unbind(await registry(), entry => entry.tests.includes('scripts/reliability-source-guard.mjs'));
  await assert.rejects(check(readOnly), /Fixture cases no test bound to scripts\/fixtures\/reliability\/source-v1\.json checks in a branch of their own .*plain-markdown/);
  await assert.rejects(check(unbind(await registry(), () => false)), /bound to no test that reads it/);
});

test('a changed file passes only when the change coverage names it', async () => {
  const value = await registry();
  const exists = () => true;
  assert.deepEqual(verifyChangeCoverage(value, ['scripts/reliability-registry-check.mjs', 'SPEC_SYSTEM_RELIABILITY.md'], { exists }).checked,
    ['scripts/reliability-registry-check.mjs']);
  assert.throws(() => verifyChangeCoverage(value, ['src-tauri/src/new_behavior.rs'], { exists }), /no requirement and no test that imports, reads or launches them \(1\):\nsrc-tauri\/src\/new_behavior\.rs/);
});

test('styles, pages and shell scripts are behavior too (А10.4)', async () => {
  const value = await registry();
  for (const path of ['src/styles/new.css', 'new-window.html', 'scripts/new-step.sh']) {
    assert.throws(() => verifyChangeCoverage(value, [path], { exists: () => true }), /no requirement and no test/, path);
  }
});

test('deleted files, declarations and Safari mirrors of bound sources are counted apart, nothing else', async () => {
  const value = await registry();
  const [{ source, mirror }] = SAFARI_MIRRORS;
  assert.ok(value.changeCoverage.some(entry => entry.paths.includes(source)), `${source} must be bound for its mirror`);
  const result = verifyChangeCoverage(value, ['src/gone.ts', 'src/types/new.ts', mirror], {
    exists: path => path !== 'src/gone.ts', declarationsOnly: path => path === 'src/types/new.ts',
  });
  assert.deepEqual(result, { checked: [], deleted: ['src/gone.ts'], declarations: ['src/types/new.ts'], mirrors: [mirror] });
  // A mirror is only as bound as its source.
  for (const entry of value.changeCoverage) entry.paths = entry.paths.filter(path => path !== source);
  assert.throws(() => verifyChangeCoverage(value, [mirror], { exists: () => true }), /no requirement and no test/);
  assert.throws(() => verifyChangeCoverage(value, ['src/new.ts'], { exists: () => true, declarationsOnly: () => false }), /no requirement and no test/);
});

test('the registry file keeps one format', async () => {
  const text = await readFile(registryPath, 'utf8');
  verifyRegistryFormat(text);
  const value = JSON.parse(text);
  assert.throws(() => verifyRegistryFormat(`${JSON.stringify(value, null, 4)}\n`), /not in its format/);
  assert.throws(() => verifyRegistryFormat(JSON.stringify(value, null, 2)), /not in its format/);
});

test('committed work since the base revision is inspected, not only uncommitted edits (А10.4)', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'mine-change-base-'));
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=Registry check test', '-c', 'user.email=registry-check@test.invalid', ...args], { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git('init', '-q', '-b', 'main');
    await writeFile(join(repo, 'README.md'), 'base\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'work');
    await writeFile(join(repo, 'style.css'), 'a { color: red }\n');
    git('add', '.');
    git('commit', '-q', '-m', 'committed change');
    await writeFile(join(repo, 'README.md'), 'edited\n');
    await writeFile(join(repo, 'run.sh'), 'echo new\n');

    const base = changeBase(repo, 'main');
    assert.equal(base, git('rev-parse', 'main'));
    assert.deepEqual(changedPaths(repo, base).sort(), ['README.md', 'run.sh', 'style.css']);
    // The working tree is clean against HEAD for the committed file: the old
    // comparison missed it.
    assert.ok(!git('diff', '--name-only', 'HEAD').split('\n').includes('style.css'));

    assert.throws(() => changeBase(repo, 'no-such-revision'), /Cannot find the base revision: no-such-revision/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('after a push the automatic base is HEAD and the registry check says it compared nothing (Б6.3)', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'mine-registry-check-pushed-'));
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=Registry check test', '-c', 'user.email=registry-check@test.invalid', ...args], { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git('init', '-q', '-b', 'main');
    await writeFile(join(repo, 'README.md'), 'base\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    await writeFile(join(repo, 'style.css'), 'a { color: red }\n');
    git('add', '.');
    git('commit', '-q', '-m', 'pushed change');
    // What `git push` leaves behind: the remote-tracking branch at HEAD.
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');

    const automatic = changeBase(repo);
    assert.equal(automatic, git('rev-parse', 'HEAD'));
    const nothing = changedPaths(repo, automatic);
    assert.deepEqual(nothing, []);
    assert.match(automaticBaseNotice(nothing, undefined), /pushed commits are not compared.*--base/);

    // An explicit base sees the pushed commit, and needs no notice.
    const explicit = changedPaths(repo, changeBase(repo, 'HEAD~1'));
    assert.deepEqual(explicit, ['style.css']);
    assert.equal(automaticBaseNotice(explicit, 'HEAD~1'), null);
    assert.equal(automaticBaseNotice(nothing, 'HEAD~1'), null);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('the current production domain and storage dependencies respect module boundaries', async () => {
  await verifyModuleBoundaries();
});

test('forbidden direct and grouped Rust imports fail the actual boundary guard', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'mine-boundary-test-'));
  try {
    await mkdir(join(temporary, 'src-tauri/src/domain'), { recursive: true });
    await mkdir(join(temporary, 'src-tauri/src/storage'), { recursive: true });
    for (const code of ['use crate::storage::db;', 'use crate::{storage::db};', 'use crate :: commands :: state;']) {
      await writeFile(join(temporary, 'src-tauri/src/domain/leak.rs'), code);
      await assert.rejects(verifyModuleBoundaries(temporary), /Forbidden module dependency/);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

async function completeEvidence(temporary) {
  const value = await registry();
  const commit = 'a'.repeat(40);
  const fixtureSha256 = sha256(await readFile(fixturePath));
  const artifactFile = join(temporary, 'candidate.bin');
  await writeFile(artifactFile, 'synthetic artifact for registry check unit tests only');
  const installedBundle = join(temporary, 'Candidate.app');
  await mkdir(installedBundle);
  await writeFile(join(installedBundle, 'executable'), 'synthetic executable');
  const artifacts = ['application', 'host', 'extension', 'cli'].map(component => ({
    id: component, component, role: 'candidate', version: '1', buildId: 'test-build', commit,
    channel: 'test-only', path: artifactFile,
    installedBundle, sha256: sha256('synthetic artifact for registry check unit tests only'),
  }));
  artifacts[0].installedBundleSha256 = await artifactDigest(installedBundle);
  const signature = join(temporary, 'candidate.sig');
  await writeFile(signature, Buffer.from('untrusted comment: synthetic validator unit test\nZmFrZQ==\ntrusted comment: not a real signature\nZmFrZQ==\n').toString('base64'));
  artifacts[0].updateSignature = signature;
  artifacts[0].updateSignatureSha256 = sha256(await readFile(signature));
  const keyPayload = Buffer.concat([Buffer.from('Ed'), Buffer.alloc(40)]).toString('base64');
  const publicKey = Buffer.from(`untrusted comment: minisign public key\n${keyPayload}\n`).toString('base64');
  const channelPath = join(temporary, 'channel.json');
  const channelBytes = JSON.stringify({ plugins: { updater: { pubkey: publicKey, endpoints: ['https://updates.mine.invalid/channel.json'] } },
    bundle: { macOS: { signingIdentity: 'Developer ID Application: Unit Test (ABCDE12345)' } } });
  await writeFile(channelPath, channelBytes);
  for (const role of ['baseline', 'previous', 'defective']) artifacts.push({ ...artifacts[1], id: role, role });
  const report = { commit, fixtureSha256, status: 'passed', exitCode: 0, skipped: 0, failed: 0, flaky: 0,
    executedIds: [...value.principles, ...value.acceptance, ...value.levels].map(item => item.id),
    assertions: ['Synthetic validator test only'], command: ['synthetic-test'], artifactIds: artifacts.map(item => item.id),
    artifacts: artifacts.map(({ id, sha256: digest, version, buildId, commit: artifactCommit, installedBundleSha256 }) =>
      ({ id, sha256: digest, version, buildId, commit: artifactCommit, installedBundleSha256 })),
    kind: 'automatic', processPaths: ['/test-only/Candidate.app/executable'], operations: ['relaunch'] };
  const reportPath = join(temporary, 'report.json');
  const reportBytes = JSON.stringify(report);
  await writeFile(reportPath, reportBytes);
  for (const item of [...value.principles, ...value.acceptance, ...value.levels]) {
    item.result = 'passed'; item.evidence = [{ path: reportPath, sha256: sha256(reportBytes) }];
  }
  const defectPath = join(temporary, 'defect.json');
  const defectBytes = JSON.stringify({ status: 'reproduced', fixtureSha256, command: ['synthetic-old-binary'],
    observedFailure: 'schema 4 vs 3', artifactIds: ['defective'], artifacts: report.artifacts.filter(item => item.id === 'defective') });
  await writeFile(defectPath, defectBytes);
  value.release = { commit, fixtureSha256, environment: { os: 'test', browser: 'test', architecture: 'test' }, artifacts,
    originalDefect: { path: defectPath, sha256: sha256(defectBytes) }, channelConfiguration: { path: channelPath, sha256: sha256(channelBytes) } };
  const execute = (command, args) => ({ status: 0, stdout: command === 'git' && args[0] === 'rev-parse' ? commit : '' });
  return { value, execute, reportPath, artifactFile, installedBundle, keyPayload };
}

test('complete synthetic evidence invokes signature verifiers and is invalidated by artifact or report changes', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'mine-evidence-test-'));
  try {
    const data = await completeEvidence(temporary);
    const calls = [];
    const execute = (command, args) => {
      calls.push(command);
      if (command === 'minisign') assert.equal(args[args.indexOf('-P') + 1], data.keyPayload);
      return data.execute(command, args);
    };
    assert.equal(await verifyRelease(data.value, undefined, { execute }), true);
    assert.ok(calls.includes('codesign') && calls.includes('spctl') && calls.includes('minisign'));
    await writeFile(data.reportPath, '{}');
    await assert.rejects(verifyRelease(data.value, undefined, { execute }), /Evidence changed/);
    const restoredDirectory = join(temporary, 'restored');
    await mkdir(restoredDirectory);
    const restored = await completeEvidence(restoredDirectory);
    await writeFile(restored.artifactFile, 'different artifact');
    await assert.rejects(verifyRelease(restored.value, undefined, { execute: restored.execute }), /Artifact bytes changed/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('artifact digest includes bundle link targets and nested file bytes', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'mine-artifact-test-'));
  try {
    await mkdir(join(temporary, 'Contents'));
    await writeFile(join(temporary, 'Contents/binary'), 'one');
    await symlink('Contents/binary', join(temporary, 'launch'));
    const before = await artifactDigest(temporary);
    await writeFile(join(temporary, 'Contents/binary'), 'two');
    assert.notEqual(await artifactDigest(temporary), before);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('signature rejection, installed bundle drift, skipped report and missing defect reproduction block release', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'mine-evidence-reject-'));
  try {
    const data = await completeEvidence(temporary);
    await assert.rejects(verifyRelease(data.value, undefined, { execute: (command, args) => command === 'codesign' ? { status: 1 } : data.execute(command, args) }), /Signature/);
    await writeFile(join(data.installedBundle, 'executable'), 'changed installed process');
    await assert.rejects(verifyRelease(data.value, undefined, { execute: data.execute }), /Installed bundle bytes/);
    data.value.release.artifacts[0].installedBundleSha256 = await artifactDigest(data.installedBundle);
    const report = JSON.parse(await readFile(data.reportPath, 'utf8'));
    report.artifacts[0].installedBundleSha256 = data.value.release.artifacts[0].installedBundleSha256;
    report.skipped = 1;
    const reportBytes = JSON.stringify(report);
    await writeFile(data.reportPath, reportBytes);
    for (const item of [...data.value.principles, ...data.value.acceptance, ...data.value.levels]) item.evidence[0].sha256 = sha256(reportBytes);
    await assert.rejects(verifyRelease(data.value, undefined, { execute: data.execute }), /skipped/);
    report.skipped = 0;
    const goodReportBytes = JSON.stringify(report);
    await writeFile(data.reportPath, goodReportBytes);
    for (const item of [...data.value.principles, ...data.value.acceptance, ...data.value.levels]) item.evidence[0].sha256 = sha256(goodReportBytes);
    data.value.release.originalDefect = null;
    await assert.rejects(verifyRelease(data.value, undefined, { execute: data.execute }), /Missing hashed evidence/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
