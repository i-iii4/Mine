import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  EXTENSION_PAYLOAD_ENTRIES,
  WORKER_WRAPPER_SOURCE,
  extensionBuildVersion,
  extensionIdFromManifest,
  replaceExtensionPayload,
  stampExtensionBuild,
  validExtensionVersion,
  workerFileName,
} from './clipper-extension-payload.mjs';

const KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx+WqWjeM8ng5zMPqS0R1Zx1u6Zhm67lPun93OqiJ/iHHSU3FH1FM3Cenkf9fh8Mf6eainVbtUXflQ8v9IGM9nsNQRXeQqpVY3USDKXIstctLZpCe4HDypkzTs3vOhox1fTBfr8t/xob6WXJwY+hTeCuZyf1pIhPNOsfgVIgJwB/KiylHx38UWkFJ4YXztJvcgLyDD350iWiy2Fq0J8n3BkFIwYBXZNU4CIUReDr0eASQhv2anol2Rju/uZSNudiXW5KeupesXFhB/3ExyIyXba2l3KJNXuMjWldGVNgXrtIozyyIstD3J9kPZyP+q5P9hm0ON/EE3Nv3BW5L2DmK4QIDAQAB';
const SOURCE_MANIFEST = `${JSON.stringify({ key: KEY, version: '0.1.0', background: { service_worker: 'background.js' } }, null, 2)}\n`;

function fixture(root, marker) {
  for (const entry of EXTENSION_PAYLOAD_ENTRIES) {
    const path = join(root, entry);
    if (entry.includes('.')) {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, marker);
    } else {
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'runtime.js'), marker);
    }
  }
  writeFileSync(join(root, 'manifest.json'), SOURCE_MANIFEST);
  writeFileSync(join(root, 'lib/standaloneVault.test.ts'), 'test-only');
  mkdirSync(join(root, 'lib/nested'), { recursive: true });
  writeFileSync(join(root, 'lib/nested/future.test.js'), 'test-only');
}

const manifestOf = root => JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

test('stable payload replacement preserves identity and excludes test sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'mine-extension-payload-'));
  const source = join(root, 'source');
  const destination = join(root, 'installed');
  mkdirSync(source);
  fixture(source, 'first');

  const id = replaceExtensionPayload(source, destination, '2026.1013.1542.37123');

  assert.equal(id, 'eioalidaccoahofcggkbinalibpajokh');
  assert.equal(extensionIdFromManifest(join(destination, 'manifest.json')), id);
  assert.throws(() => readFileSync(join(destination, 'lib/standaloneVault.test.ts')));
  assert.throws(() => readFileSync(join(destination, 'lib/nested/future.test.js')));

  writeFileSync(join(source, 'background.js'), 'second');
  replaceExtensionPayload(source, destination, '2026.1013.1543.0');
  assert.equal(readFileSync(join(destination, 'background.js'), 'utf8'), 'second');
});

// A browser restart runs the registered worker unless both the version and
// the worker's address changed (SPEC_CLIPPER.md, К4).
test('each payload carries its own version and worker wrapper, the source keeps its own', () => {
  const root = mkdtempSync(join(tmpdir(), 'mine-extension-payload-'));
  const source = join(root, 'source');
  const destination = join(root, 'installed');
  mkdirSync(source);
  fixture(source, 'build');

  replaceExtensionPayload(source, destination, '2026.1013.1542.37123');
  const first = manifestOf(destination);
  assert.equal(first.version, '2026.1013.1542.37123');
  assert.equal(first.background.service_worker, 'worker-2026.1013.1542.37123.js');
  assert.equal(readFileSync(join(destination, first.background.service_worker), 'utf8'), WORKER_WRAPPER_SOURCE);
  assert.equal(readFileSync(join(destination, 'background.js'), 'utf8'), 'build');
  assert.equal(first.key, KEY);

  replaceExtensionPayload(source, destination, '2026.1013.1542.37124');
  const second = manifestOf(destination);
  assert.equal(second.background.service_worker, 'worker-2026.1013.1542.37124.js');
  assert.equal(existsSync(join(destination, first.background.service_worker)), false);
  assert.equal(readFileSync(join(source, 'manifest.json'), 'utf8'), SOURCE_MANIFEST);
  assert.equal(existsSync(join(source, second.background.service_worker)), false);
});

test('stamping an already stamped payload replaces its wrapper', () => {
  const root = mkdtempSync(join(tmpdir(), 'mine-extension-payload-'));
  fixture(root, 'build');
  const first = stampExtensionBuild(root, '1.2.3.4');
  const second = stampExtensionBuild(root, '1.2.3.5');
  assert.equal(first, workerFileName('1.2.3.4'));
  assert.equal(existsSync(join(root, first)), false);
  assert.equal(readFileSync(join(root, second), 'utf8'), WORKER_WRAPPER_SOURCE);
  assert.equal(manifestOf(root).version, '1.2.3.5');
  assert.throws(() => stampExtensionBuild(root, '1.02'), /Invalid extension version/);
  const manifest = manifestOf(root);
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ ...manifest, background: { service_worker: 'other.js' } }));
  assert.throws(() => stampExtensionBuild(root, '1.2.3.6'), /Unexpected extension worker/);
});

test('build versions are valid for Chromium and grow with build time', () => {
  const times = ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.001Z', '2026-01-01T00:00:59.999Z',
    '2026-01-01T00:01:00.000Z', '2026-01-01T23:59:59.999Z', '2026-01-02T00:00:00.000Z',
    '2026-10-13T15:42:37.123Z', '2026-12-31T23:59:59.999Z', '2027-01-01T00:00:00.000Z'];
  const versions = times.map(time => extensionBuildVersion(new Date(time)));
  assert.equal(versions[0], '2026.101.0.0');
  assert.equal(versions[6], '2026.1013.1542.37123');
  const compare = (left, right) => {
    const a = left.split('.').map(Number);
    const b = right.split('.').map(Number);
    for (let index = 0; index < 4; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
    return 0;
  };
  for (const [index, version] of versions.entries()) {
    assert.ok(validExtensionVersion(version), version);
    if (index > 0) assert.ok(compare(versions[index - 1], version) < 0, `${versions[index - 1]} < ${version}`);
  }
  for (const invalid of ['', '1.2.3.4.5', '01.2', '1.02', '65536', '1..2', '1.-2', 'a.b']) {
    assert.equal(validExtensionVersion(invalid), false, invalid);
  }
  assert.ok(validExtensionVersion('65535.0.0.0'));
});
