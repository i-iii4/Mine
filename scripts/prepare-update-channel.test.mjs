import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { prepareUpdateChannel } from './prepare-update-channel.mjs';

const bytes = Buffer.alloc(42, 1);
bytes.write('Ed');
const publicKey = Buffer.from(`untrusted comment: minisign public key\n${bytes.toString('base64')}\n`).toString('base64');
const valid = { endpoint: 'https://releases.mine.test/stable/latest.json', publicKey, appleSigningIdentity: 'Developer ID Application: Test (ABCDEFGHIJ)' };

test('prepares a signed Tauri configuration without activating it', () => {
  const result = prepareUpdateChannel(valid);
  assert.equal(result.bundle.createUpdaterArtifacts, true);
  assert.equal(result.plugins.updater.pubkey, publicKey);
  assert.deepEqual(result.plugins.updater.endpoints, [valid.endpoint]);
  assert.equal(result.bundle.macOS.hardenedRuntime, true);
});

test('rejects missing inputs, unsafe endpoints and fake keys', () => {
  for (const input of [null, {}, { ...valid, endpoint: 'http://mine.test/latest.json' },
    { ...valid, endpoint: 'https://user:secret@mine.test/latest.json' },
    { ...valid, endpoint: 'https://example.com/latest.json' },
    { ...valid, publicKey: 'placeholder' }, { ...valid, appleSigningIdentity: '-' },
    { ...valid, privateKey: 'must-not-be-accepted' }]) {
    assert.throws(() => prepareUpdateChannel(input));
  }
});

test('rejects a private-key document', () => {
  const secret = Buffer.from(`untrusted comment: minisign secret key\n${bytes.toString('base64')}\n`).toString('base64');
  assert.throws(() => prepareUpdateChannel({ ...valid, publicKey: secret }), /public-key document/);
});

test('CLI never overwrites an existing configuration', () => {
  const root = mkdtempSync(join(tmpdir(), 'mine-update-inputs-'));
  try {
    const input = join(root, 'input.json');
    const output = join(root, 'output.json');
    writeFileSync(input, JSON.stringify(valid));
    writeFileSync(output, 'existing');
    const result = spawnSync(process.execPath, ['scripts/prepare-update-channel.mjs', input, output], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(readFileSync(output, 'utf8'), 'existing');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
