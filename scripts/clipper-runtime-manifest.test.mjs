import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createRuntimeManifest,
  fileComponentManifest,
  treeComponentManifest,
} from './build-clipper-runtime-manifest.mjs';

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
    extension,
    ytdlp: join(root, 'yt-dlp'),
  });
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.build_profile, 'release');
  assert.equal(manifest.app_version, '1.2.3');
  assert.equal(manifest.native_host.bytes, 4);
  assert.equal(manifest.ytdlp?.bytes, 6);
});
