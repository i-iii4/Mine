import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { SAFARI_MIRRORS, verifyExtensionMirrors } from './verify-extension-mirrors.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mine-extension-mirrors-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [index, pair] of SAFARI_MIRRORS.entries()) {
    for (const path of [pair.source, pair.mirror]) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), `fixture source ${index}\n`);
    }
  }
  return root;
}

test('actual generated Safari resources equal all four exact extension sources', async () => {
  const evidence = await verifyExtensionMirrors();
  assert.equal(evidence.length, 4);
  assert.ok(evidence.every(item => /^[a-f0-9]{64}$/.test(item.sha256)));
});

test('a stale generated copy is rejected even when its path is covered', async t => {
  const root = await fixture(t);
  assert.equal((await verifyExtensionMirrors(root)).length, 4);
  await writeFile(join(root, SAFARI_MIRRORS[0].mirror), 'older build\n');
  await assert.rejects(verifyExtensionMirrors(root), /differs from its extension source/);
});

test('a missing file or symlink cannot satisfy mirror equality', async t => {
  const root = await fixture(t);
  const pair = SAFARI_MIRRORS[1];
  await rm(join(root, pair.mirror));
  await assert.rejects(verifyExtensionMirrors(root), /ENOENT/);
  await symlink(join(root, pair.source), join(root, pair.mirror));
  await assert.rejects(verifyExtensionMirrors(root), /regular file/);
});
