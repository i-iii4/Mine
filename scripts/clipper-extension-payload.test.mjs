import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  EXTENSION_PAYLOAD_ENTRIES,
  extensionIdFromManifest,
  replaceExtensionPayload,
} from './clipper-extension-payload.mjs';

const KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx+WqWjeM8ng5zMPqS0R1Zx1u6Zhm67lPun93OqiJ/iHHSU3FH1FM3Cenkf9fh8Mf6eainVbtUXflQ8v9IGM9nsNQRXeQqpVY3USDKXIstctLZpCe4HDypkzTs3vOhox1fTBfr8t/xob6WXJwY+hTeCuZyf1pIhPNOsfgVIgJwB/KiylHx38UWkFJ4YXztJvcgLyDD350iWiy2Fq0J8n3BkFIwYBXZNU4CIUReDr0eASQhv2anol2Rju/uZSNudiXW5KeupesXFhB/3ExyIyXba2l3KJNXuMjWldGVNgXrtIozyyIstD3J9kPZyP+q5P9hm0ON/EE3Nv3BW5L2DmK4QIDAQAB';

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
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ key: KEY }));
  writeFileSync(join(root, 'lib/standaloneVault.test.ts'), 'test-only');
  mkdirSync(join(root, 'lib/nested'), { recursive: true });
  writeFileSync(join(root, 'lib/nested/future.test.js'), 'test-only');
}

test('stable payload replacement preserves identity and excludes test sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'mine-extension-payload-'));
  const source = join(root, 'source');
  const destination = join(root, 'installed');
  mkdirSync(source);
  fixture(source, 'first');

  const id = replaceExtensionPayload(source, destination);

  assert.equal(id, 'eioalidaccoahofcggkbinalibpajokh');
  assert.equal(extensionIdFromManifest(join(destination, 'manifest.json')), id);
  assert.throws(() => readFileSync(join(destination, 'lib/standaloneVault.test.ts')));
  assert.throws(() => readFileSync(join(destination, 'lib/nested/future.test.js')));

  writeFileSync(join(source, 'background.js'), 'second');
  replaceExtensionPayload(source, destination);
  assert.equal(readFileSync(join(destination, 'background.js'), 'utf8'), 'second');
});
