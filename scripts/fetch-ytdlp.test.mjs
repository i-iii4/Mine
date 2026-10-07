import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeOnedir } from './fetch-ytdlp.mjs';

/** The vendor archive as unpacked: the framework's symlinks spelled as copies. */
function vendorTree({ python = 'python bytes', copy = 'python bytes', plist = '<plist/>', extra } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mine-ytdlp-onedir-'));
  const framework = join(root, '_internal/Python.framework');
  mkdirSync(join(framework, 'Versions/3.14/Resources'), { recursive: true });
  mkdirSync(join(framework, 'Versions/Current/Resources'), { recursive: true });
  mkdirSync(join(framework, 'Resources'), { recursive: true });
  writeFileSync(join(root, 'yt-dlp_macos'), 'launcher');
  writeFileSync(join(root, '_internal/Python'), python);
  writeFileSync(join(root, '_internal/libssl.3.dylib'), 'ssl');
  for (const at of ['Python', 'Versions/3.14/Python', 'Versions/Current/Python']) writeFileSync(join(framework, at), copy);
  for (const at of ['Resources/Info.plist', 'Versions/3.14/Resources/Info.plist', 'Versions/Current/Resources/Info.plist']) {
    writeFileSync(join(framework, at), plist);
  }
  extra?.(root);
  return root;
}

test('the shipped tree drops the copied framework and names the launcher', async () => {
  const root = vendorTree();
  await normalizeOnedir(root);
  assert.ok(statSync(join(root, 'yt-dlp')).isFile());
  assert.equal(statSync(join(root, 'yt-dlp')).mode & 0o111, 0o111);
  assert.ok(!existsSync(join(root, 'yt-dlp_macos')));
  assert.ok(!existsSync(join(root, '_internal/Python.framework')));
  assert.ok(existsSync(join(root, '_internal/Python')));
  assert.ok(existsSync(join(root, '_internal/libssl.3.dylib')));
});

test('a framework copy that differs from what stays stops the fetch', async () => {
  await assert.rejects(normalizeOnedir(vendorTree({ copy: 'another python' })), /differs from _internal\/Python/);
  await assert.rejects(normalizeOnedir(vendorTree({
    extra: (root) => writeFileSync(join(root, '_internal/Python.framework/Versions/3.14/Resources/Info.plist'), '<other/>'),
  })), /differs from its copies/);
  await assert.rejects(normalizeOnedir(vendorTree({
    extra: (root) => writeFileSync(join(root, '_internal/Python.framework/Versions/3.14/lib.dylib'), 'new'),
  })), /has no kept counterpart/);
});

test('a symlink or a missing launcher stops the fetch', async () => {
  await assert.rejects(normalizeOnedir(vendorTree({
    extra: (root) => symlinkSync('libssl.3.dylib', join(root, '_internal/libssl.dylib')),
  })), /is a symlink/);
  await assert.rejects(normalizeOnedir(vendorTree({
    extra: (root) => symlinkSync('Versions/Current/Python', join(root, '_internal/Python.framework/Link')),
  })), /is not a file/);
  const root = vendorTree();
  await normalizeOnedir(root);
  await assert.rejects(normalizeOnedir(root), /yt-dlp_macos is missing/);
});
