import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeLocalBundle } from './finalize-local-bundle.mjs';
import { fileComponentManifest } from './build-clipper-runtime-manifest.mjs';

function fixture() {
  const bundle = join(mkdtempSync(join(tmpdir(), 'mine-finalize-')), 'Mine.app');
  const macos = join(bundle, 'Contents/MacOS'), resources = join(bundle, 'Contents/Resources');
  mkdirSync(macos, { recursive: true }); mkdirSync(join(resources, 'binaries'), { recursive: true });
  mkdirSync(join(resources, 'clipper-extension'), { recursive: true });
  for (const path of [join(macos, 'mine'), join(macos, 'native-host'), join(resources, 'binaries/yt-dlp')]) {
    writeFileSync(path, Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.from(path)]));
  }
  writeFileSync(join(bundle, 'Contents/Info.plist'), '{}');
  writeFileSync(join(resources, 'clipper-extension/manifest.json'), '{}');
  writeFileSync(join(resources, 'clipper-runtime-manifest.json'), '{"stale":true}');
  return bundle;
}
function runner(bundle, options = {}) {
  const calls = [];
  return { calls, execute(command, args) {
    calls.push({ command, args });
    if (command.endsWith('/plutil')) return { status: 0, stdout: JSON.stringify({ CFBundleExecutable: 'mine', CFBundleShortVersionString: '0.1.0' }) };
    if (args.includes('--force')) {
      const target = args.at(-1);
      if (target === bundle) {
        const manifest = JSON.parse(readFileSync(join(bundle, 'Contents/Resources/clipper-runtime-manifest.json'), 'utf8'));
        assert.deepEqual(manifest.native_host, fileComponentManifest(join(bundle, 'Contents/MacOS/native-host')));
        if (options.outerMutatesNested) appendFileSync(join(bundle, 'Contents/MacOS/native-host'), 'unexpected deep mutation');
      } else appendFileSync(target, 'signed bytes');
    }
    if (args.includes('--verify') && options.failVerify) return { status: 1, stderr: 'invalid seal' };
    return { status: 0, stdout: '' };
  } };
}
const probe = () => ({ schema_version: 1, version: '0.1.0', build_id: 'a'.repeat(64), commit: 'fixture', save_protocols: [1] });

test('nested signing precedes actual-byte manifest and outer-only signature', () => {
  const bundle = fixture(), harness = runner(bundle);
  const report = finalizeLocalBundle(bundle, { platform: 'darwin', execute: harness.execute, probe });
  assert.equal(report.nested_signed, 2); assert.equal(report.runtime_verified, true);
  const signing = harness.calls.filter(call => call.args.includes('--force'));
  assert.equal(signing.at(-1).args.at(-1), bundle);
  assert.ok(signing.every(call => !call.args.includes('--deep')));
  assert.deepEqual(report.manifest.native_host, fileComponentManifest(join(bundle, 'Contents/MacOS/native-host')));
  assert.deepEqual(report.manifest.ytdlp, fileComponentManifest(join(bundle, 'Contents/Resources/binaries/yt-dlp')));
  assert.ok(harness.calls.at(-1).args.includes('--verify'));
});
test('post-manifest signing mutation or signature failure never reports success', () => {
  for (const options of [{ outerMutatesNested: true }, { failVerify: true }]) {
    const bundle = fixture(), harness = runner(bundle, options);
    assert.throws(() => finalizeLocalBundle(bundle, { platform: 'darwin', execute: harness.execute, probe }), /differ|invalid seal/);
  }
});
test('launch identity changing after signing is rejected', () => {
  const bundle = fixture(), harness = runner(bundle); let calls = 0;
  assert.throws(() => finalizeLocalBundle(bundle, { platform: 'darwin', execute: harness.execute,
    probe: () => ({ ...probe(), build_id: (++calls === 1 ? 'a' : 'b').repeat(64) }) }), /identity differs/);
});
test('platform refusal happens before signing or resource changes', () => {
  const bundle = fixture(), harness = runner(bundle);
  assert.throws(() => finalizeLocalBundle(bundle, { platform: 'linux', execute: harness.execute, probe }), /macOS/);
  assert.equal(harness.calls.length, 0);
});
