import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ACCEPTANCE, PRINCIPLES, artifactDigest, registryPath, validateRegistry, verifyChangeCoverage, verifyModuleBoundaries, verifyRelease } from './reliability-gate.mjs';
import { fixturePath, sha256 } from './reliability-source-guard.mjs';

async function registry() { return JSON.parse(await readFile(registryPath, 'utf8')); }

test('all eleven principles, 24 scenarios and four levels have executable owners', async () => {
  const value = await registry();
  await validateRegistry(value);
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
    await assert.rejects(validateRegistry(value));
  }
  for (const result of ['pending', 'failed', 'skipped', 'flaky']) {
    const value = await registry(); value.acceptance[0].result = result;
    await assert.rejects(verifyRelease(value), /Release blocked/);
  }
});

test('ordinary registry checks pass while the actual release CLI exits nonzero', () => {
  const execution = spawnSync(process.execPath, [fileURLToPath(new URL('./reliability-gate.mjs', import.meta.url)), '--release'], { encoding: 'utf8' });
  assert.equal(execution.status, 1);
  assert.match(execution.stderr, /Release blocked/);
  assert.match(execution.stderr, /A01/);
  assert.match(execution.stderr, /A24/);
});

test('new behavior without a requirement and executable check is rejected', async () => {
  const value = await registry();
  verifyChangeCoverage(value, ['scripts/reliability-gate.mjs', 'SPEC_SYSTEM_RELIABILITY.md']);
  assert.throws(() => verifyChangeCoverage(value, ['src-tauri/src/new_behavior.rs']), /no requirement and check/);
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
  await writeFile(artifactFile, 'synthetic artifact for gate unit tests only');
  const installedBundle = join(temporary, 'Candidate.app');
  await mkdir(installedBundle);
  await writeFile(join(installedBundle, 'executable'), 'synthetic executable');
  const artifacts = ['application', 'host', 'extension', 'cli'].map(component => ({
    id: component, component, role: 'candidate', version: '1', buildId: 'test-build', commit,
    channel: 'test-only', path: artifactFile,
    installedBundle, sha256: sha256('synthetic artifact for gate unit tests only'),
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
