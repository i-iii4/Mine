import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceBuildIdentity } from './build-identity.mjs';

test('identity tracks source bytes but ignores generated bundles', () => {
  const root = mkdtempSync(join(tmpdir(), 'mine-build-identity-'));
  try {
    mkdirSync(join(root, 'extension/dist'), { recursive: true });
    writeFileSync(join(root, 'extension/background.js'), 'original');
    const initial = sourceBuildIdentity(root);
    assert.match(initial.buildId, /^[a-f0-9]{64}$/);
    assert.equal(initial.commit, 'source-archive');
    assert.deepEqual(sourceBuildIdentity(root), initial);
    writeFileSync(join(root, 'extension/dist/overlay.js'), 'generated');
    assert.deepEqual(sourceBuildIdentity(root), initial);
    writeFileSync(join(root, 'extension/background.js'), 'modified');
    assert.notEqual(sourceBuildIdentity(root).buildId, initial.buildId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
