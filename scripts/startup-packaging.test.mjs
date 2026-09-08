import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertBundleInventory } from './verify-startup-bundle.mjs';
import { parseStartupTrace } from './startup-performance-acceptance.mjs';

const root = new URL('../', import.meta.url);
const cargo = readFileSync(new URL('src-tauri/Cargo.toml', root), 'utf8');
const config = JSON.parse(readFileSync(new URL('src-tauri/tauri.conf.json', root), 'utf8'));

function binBlock(name) {
  const blocks = cargo.split('[[bin]]').slice(1);
  return blocks.find((block) => block.match(new RegExp(`\\bname = "${name}"`))) ?? '';
}

test('GUI builds exclude developer and migration binaries', () => {
  const toolingBins = [
    'mine-cli',
    'migrate-body-to-wikilinks',
    'migrate-collections-to-wikilinks',
    'migrate-primary-file-to-wikilinks',
    'localize-remote-media',
    'migrate-vault-layout',
    'cold-space-audit',
    'export-bindings',
  ];
  for (const name of toolingBins) {
    const block = binBlock(name);
    assert.match(block, /required-features = \[[^\]]*"tooling"/);
    assert.match(block, /path = "src\/tooling\//);
  }
  assert.doesNotMatch(binBlock('mine'), /"tooling"/);
  assert.doesNotMatch(binBlock('native-host'), /"tooling"/);
});

test('Tauri bundle hook creates and ships the runtime manifest', () => {
  assert.equal(config.build.beforeBundleCommand, 'node scripts/build-clipper-runtime-manifest.mjs');
  assert.equal(
    config.bundle.resources['../build/clipper-runtime-manifest.json'],
    'clipper-runtime-manifest.json',
  );
});

test('bundle inventory rejects unrelated executables', () => {
  const root = mkdtempSync(join(tmpdir(), 'mine-bundle-inventory-'));
  const macos = join(root, 'Mine.app/Contents/MacOS');
  const resources = join(root, 'Mine.app/Contents/Resources');
  mkdirSync(macos, { recursive: true });
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(macos, 'mine'), '');
  writeFileSync(join(macos, 'native-host'), '');
  writeFileSync(join(resources, 'clipper-runtime-manifest.json'), '{}');
  assert.doesNotThrow(() => assertBundleInventory(join(root, 'Mine.app')));
  writeFileSync(join(macos, 'mine-cli'), '');
  assert.throws(() => assertBundleInventory(join(root, 'Mine.app')), /mine-cli/);
});

test('startup trace parser returns monotonic milestones for one launch', () => {
  const trace = [
    '2026-09-08T12:00:00Z launch_id=42-1 launch_elapsed_ms=10 [process] started',
    '2026-09-08T12:00:00Z launch_id=42-1 launch_elapsed_ms=80 [window] created',
    '2026-09-08T12:00:00Z launch_id=42-1 launch_elapsed_ms=120 [startup] milestone=window_shell_painted',
    '2026-09-08T12:00:00Z launch_id=42-1 launch_elapsed_ms=240 [startup] milestone=first_cards_painted',
    '2026-09-08T12:00:00Z launch_id=42-1 launch_elapsed_ms=245 [startup] milestone=interactive',
    '2026-09-08T12:00:00Z launch_id=42-1 launch_elapsed_ms=246 [startup_maintenance] start',
  ].join('\n');
  assert.deepEqual(parseStartupTrace(trace), {
    launchId: '42-1',
    windowShellMs: 80,
    frontendShellPaintedMs: 120,
    firstCardsMs: 240,
    interactiveMs: 245,
    maintenanceStartMs: 246,
  });
});
