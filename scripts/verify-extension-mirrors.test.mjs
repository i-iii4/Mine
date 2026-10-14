import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { SAFARI_MIRRORS, SAFARI_RESOURCES, safariMirrors, verifyExtensionMirrors } from './verify-extension-mirrors.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));

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

test('actual generated Safari resources equal all registered extension sources', async () => {
  const evidence = await verifyExtensionMirrors();
  assert.equal(evidence.length, SAFARI_MIRRORS.length);
  assert.ok(evidence.every(item => /^[a-f0-9]{64}$/.test(item.sha256)));
});

test('a stale generated copy is rejected even when its path is covered', async t => {
  const root = await fixture(t);
  assert.equal((await verifyExtensionMirrors(root)).length, SAFARI_MIRRORS.length);
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

test('every Safari script and manifest copied from the extension is a compared mirror', () => {
  const mirrors = new Set(SAFARI_MIRRORS.map(item => item.mirror));
  const copies = [];
  function visit(directory, prefix = '') {
    for (const entry of readdirSync(join(repository, directory), { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      // Build output the build copies whole; Git does not keep it.
      if (entry.isDirectory() && !['dist', 'generated'].includes(path)) visit(`${directory}/${entry.name}`, `${path}/`);
      else if (entry.isFile() && /\.(?:js|json)$/.test(path) && existsSync(join(repository, 'extension', path))) copies.push(path);
    }
  }
  visit(SAFARI_RESOURCES);
  assert.ok(copies.includes('content.js') && copies.includes('lib/xThread.js'), 'the walk must see the copied scripts');
  for (const path of copies) assert.ok(mirrors.has(`${SAFARI_RESOURCES}/${path}`), `${path} is copied but never compared`);
});

test('a library script added to the extension becomes a mirror, a test of it does not', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mine-extension-mirror-rule-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'extension/lib'), { recursive: true });
  for (const name of ['added.js', 'added.test.js', 'added.types.d.ts']) await writeFile(join(root, 'extension/lib', name), '');
  assert.deepEqual(safariMirrors(root).map(item => item.source),
    ['extension/background.js', 'extension/content.js', 'extension/manifest.json', 'extension/lib/added.js']);
});
