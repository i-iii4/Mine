import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createRuntimeManifest,
  fileComponentManifest,
  treeComponentManifest,
  probeNativeHost,
} from './build-clipper-runtime-manifest.mjs';

test('bounded native probe rejects failed launches and pins actual helper identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'mine-runtime-probe-'));
  const host = join(root, 'helper');
  const identity = { schema_version: 1, version: '1.2.3', build_id: 'a'.repeat(64), commit: 'source', save_protocols: [1] };
  function executable(body) { writeFileSync(host, `#!/bin/sh\n${body}\n`); chmodSync(host, 0o755); }
  executable(`printf '%s' '${JSON.stringify(identity)}'`);
  assert.deepEqual(probeNativeHost(host, '1.2.3'), identity);
  assert.throws(() => probeNativeHost(host, '2.0.0'), /identity/);
  for (const changed of [{ ...identity, build_id: 'unbuilt' }, { ...identity, save_protocols: [2] }]) {
    executable(`printf '%s' '${JSON.stringify(changed)}'`);
    assert.throws(() => probeNativeHost(host, '1.2.3'), /identity/);
  }
  executable('exit 7'); assert.throws(() => probeNativeHost(host, '1.2.3'), /probe failed/);
  executable("printf '%s' 'malformed'"); assert.throws(() => probeNativeHost(host, '1.2.3'));
  executable('while :; do :; done'); assert.throws(() => probeNativeHost(host, '1.2.3', 30), /probe failed/);
});

test('runtime manifest changes when a component changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'mine-runtime-manifest-'));
  const host = join(root, 'native-host');
  writeFileSync(host, 'first');
  const first = fileComponentManifest(host);
  writeFileSync(host, 'second');
  assert.notDeepEqual(fileComponentManifest(host), first);
});

test('extension tree digest includes paths, lengths, and bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'mine-extension-manifest-'));
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'manifest.json'), '{}');
  writeFileSync(join(root, 'nested/content.js'), 'first');
  const first = treeComponentManifest(root);
  writeFileSync(join(root, 'nested/content.js'), 'second');
  assert.notDeepEqual(treeComponentManifest(root), first);
});

test('build manifest uses one schema for every runtime component', () => {
  const root = mkdtempSync(join(tmpdir(), 'mine-build-manifest-'));
  const extension = join(root, 'extension');
  mkdirSync(extension);
  writeFileSync(join(extension, 'manifest.json'), '{}');
  for (const file of ['host', 'yt-dlp']) writeFileSync(join(root, file), file);
  const manifest = createRuntimeManifest({
    appVersion: '1.2.3',
    buildProfile: 'release',
    nativeHost: join(root, 'host'),
    nativeHostBuildId: 'a'.repeat(64),
    extension,
    ytdlp: join(root, 'yt-dlp'),
  });
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.build_profile, 'release');
  assert.equal(manifest.app_version, '1.2.3');
  assert.equal(manifest.native_host_build_id, 'a'.repeat(64));
  assert.equal(manifest.native_host.bytes, 4);
  assert.equal(manifest.ytdlp?.bytes, 6);
});
