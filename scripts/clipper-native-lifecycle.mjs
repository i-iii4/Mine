// Actual page + packaged overlay + Chrome native transport + packaged helper.
// Only UUID-owned fixtures and a disposable browser registration are created.
// The scanner returns the production GridSnapshot; this is not Tauri UI evidence.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { renderCapturedCard } from './clipper-card-render.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const options = new Map();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  assert.ok(['--extension', '--host', '--scanner'].includes(args[index]) && isAbsolute(args[index + 1] ?? ''), 'Expected absolute --extension/--host/--scanner paths');
  options.set(args[index], args[index + 1]);
}
const bundle = join(root, 'target/release/bundle/macos/Mine.app/Contents');
const extension = options.get('--extension') ?? join(bundle, 'Resources/clipper-extension');
const host = options.get('--host') ?? join(bundle, 'MacOS/native-host');
const scanner = options.get('--scanner') ?? join(root, 'target/debug/cold-space-audit');
await Promise.all([access(extension), access(host), access(scanner)]);
const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
const background = await readFile(join(extension, 'background.js'), 'utf8');
const hostName = background.match(/const HOST_NAME = "([^"]+)";/)?.[1];
assert.ok(hostName, 'Packaged native host name is unavailable');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const extensionId = digest(Buffer.from(manifest.key, 'base64')).slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + Number.parseInt(digit, 16)));
const output = join(root, 'output/playwright');
await mkdir(output, { recursive: true });
const run = await mkdtemp(join(output, 'clipper-native-lifecycle-'));
const profile = await mkdtemp(join(tmpdir(), 'mine-native-lifecycle-profile-'));
const source = join(run, 'source');
await mkdir(join(source, '.mine'), { recursive: true });
const vaultId = `clipper-lifecycle-${randomUUID()}`;
await writeFile(join(source, '.mine/vault-id'), `${vaultId}\n`, { flag: 'wx' });
const bindingId = digest(source);
assert.ok(process.env.HOME, 'The production helper requires the existing HOME');
const appState = join(process.env.HOME, 'Library/Application Support/com.mine.app');
const fixtureDerived = join(appState, 'vaults', vaultId);
const fixtureJournal = join(appState, 'vaults/operations/v1', bindingId);
await Promise.all([fixtureDerived, fixtureJournal].map(path => assert.rejects(access(path), { code: 'ENOENT' }, `Refuse an existing fixture namespace: ${path}`)));
const log = join(run, 'native-wire.jsonl');
const fault = join(run, 'response-loss');
const launcher = join(profile, 'native-launcher');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
await writeFile(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(root, 'scripts/clipper-native-relay.mjs'))} ${quote(host)} ${quote(source)} ${quote(log)} ${quote(fault)} "$@"\n`, { flag: 'wx' });
await chmod(launcher, 0o700);
await mkdir(join(profile, 'NativeMessagingHosts'));
await writeFile(join(profile, `NativeMessagingHosts/${hostName}.json`), JSON.stringify({
  name: hostName, description: 'Disposable Mine lifecycle acceptance', path: launcher,
  type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`],
}), { flag: 'wx' });
const fixtureUrl = 'https://example.test/mine-native-lifecycle';
const selection = 'Original selected material survives closure, a changed page and a lost acknowledgement.';
const otherSelection = 'Independent second editor keeps its own selected material and collection.';
const html = `<!doctype html><html><head><title>Native lifecycle fixture</title></head><body><h1>Native lifecycle fixture</h1><p id="selection">${selection}</p><p id="alternate-selection">${otherSelection}</p></body></html>`;
const collectionName = 'Lifecycle collection';
const otherCollectionName = 'Lifecycle second collection';
const report = { ok: false, kind: 'real-page-overlay-native-wire-files-production-grid-snapshot',
  source, fixtureDerived, fixtureJournal, extension, extensionId, host, hostSha256: digest(await readFile(host)),
  scanner, scannerSha256: digest(await readFile(scanner)),
  runtimeIdentity: JSON.parse(await readFile(join(extension, 'dist/runtime-identity.json'), 'utf8')),
  diagnosticAckSuppressed: true, knownVaultReadSuppressed: true, fixtureVaultDispatchEnforced: true, assertions: [] };
let context;
let worker;
const timeout = 20_000;
async function launch() {
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  await context.route(`${fixtureUrl}*`, route => route.fulfill({ contentType: 'text/html', body: html }));
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout });
  await worker.evaluate(async ({ source, bindingId }) => {
    await chrome.storage.local.set({ mineSaveDestination: { executor: 'native', vaultPath: source, bindingId }, mineKnownVaults: [source] });
  }, { source, bindingId });
}
async function pageWithOverlay(select = false, url = fixtureUrl, selectedElement = '#selection') {
  const page = await context.newPage();
  await page.goto(url);
  if (select) await page.locator(selectedElement).evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  });
  const tabId = await worker.evaluate(async url => {
    const tabs = await chrome.tabs.query({ url });
    const tab = tabs.at(-1);
    if (!tab) throw new Error('Fixture tab unavailable');
    await openClipperUi(tab);
    return tab.id;
  }, url);
  const ui = page.locator('[data-mine-clipper-overlay]');
  await ui.waitFor({ timeout });
  await ui.getByRole('button', { name: 'Content', exact: true }).waitFor({ timeout });
  return { page, ui, tabId };
}
async function waitFor(check, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
}
async function wireLog() {
  try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function markdownFiles(directory = source) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(path));
    else if (entry.name.endsWith('.md')) files.push({ path, content: await readFile(path, 'utf8') });
  }
  return files;
}
const exec = (binary, args) => new Promise((resolve, reject) => execFile(binary, args,
  { cwd: root, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)));
try {
  await launch();
  const collection = await worker.evaluate(async ({ source, name }) => sendNativeMessage({ action: 'create_channel', vault_path: source, tag: name }), { source, name: collectionName });
  assert.equal(collection.ok, true, JSON.stringify(collection));
  const otherCollection = await worker.evaluate(async ({ source, name }) => sendNativeMessage({ action: 'create_channel', vault_path: source, tag: name }), { source, name: otherCollectionName });
  assert.equal(otherCollection.ok, true, JSON.stringify(otherCollection));
  const first = await pageWithOverlay(true);
  await first.ui.getByText(selection, { exact: true }).waitFor({ timeout });
  // Actual UI edits available in this product: capture type and collection.
  await first.ui.getByRole('button', { name: 'Link', exact: true }).click();
  await first.ui.getByRole('button', { name: 'Content', exact: true }).click();
  await first.ui.getByRole('button', { name: `Connect ${collectionName}`, exact: true }).click();
  await waitFor(() => worker.evaluate(async ({ url, selection }) => {
    const stored = await chrome.storage.local.get(null);
    return Object.values(stored).some(value => value?.sourceUrl === url && value?.draft?.state?.metadata?.selection === selection
      && value.draft.state.selectedTags?.length === 1 && value.draft.state.currentType === 'content');
  }, { url: fixtureUrl, selection }), 'acknowledged draft with selection and collection');
  await context.close(); context = undefined;
  await launch();
  // Force a different tab identity without supplying any persisted capture ID.
  const intervening = await context.newPage();
  const second = await pageWithOverlay(false);
  assert.notEqual(second.tabId, first.tabId, 'Browser reopen must use a new source tab identity');
  await second.ui.getByText(selection, { exact: true }).waitFor({ timeout });
  await second.ui.getByRole('button', { name: 'Save to 1 collection', exact: true }).waitFor({ timeout });
  report.assertions.push('normal-overlay-reopen-restores-selection-type-and-collection-with-new-tab');
  await writeFile(`${fault}.armed`, 'drop one committed Save response', { flag: 'wx' });
  await second.ui.getByRole('button', { name: 'Save to 1 collection', exact: true }).click();
  await waitFor(async () => (await wireLog()).some(event => event.kind === 'committed-response-dropped'), 'real committed response intercepted');
  await second.ui.locator('[data-clipper-save-error]').waitFor({ timeout });
  assert.equal(await second.ui.locator('[data-clipper-saved]').count(), 0);
  const dropped = (await wireLog()).find(event => event.kind === 'committed-response-dropped');
  const savedPath = join(source, `${dropped.response.slug}.md`);
  const originalBytes = await readFile(savedPath);
  assert.ok(originalBytes.toString().includes(selection));
  assert.match(originalBytes.toString(), /Mine Collections:\s*\n\s*-\s*["']?\[\[Lifecycle collection\]\]/);
  const beforeRetry = (await wireLog()).filter(event => event.kind === 'lookup-delivery-interrupted').length;
  const devtools = await context.newCDPSession(second.page);
  try {
    const { targetInfos } = await devtools.send('Target.getTargets');
    const target = targetInfos.find(item => item.type === 'service_worker' && item.url === `chrome-extension://${extensionId}/background.js`);
    assert.ok(target, 'The packaged worker must exist before its forced restart');
    assert.equal((await devtools.send('Target.closeTarget', { targetId: target.targetId })).success, true);
    await waitFor(async () => !(await devtools.send('Target.getTargets')).targetInfos.some(item => item.targetId === target.targetId), 'worker destroyed after committed response loss');
    await second.ui.getByRole('button', { name: 'Retry', exact: true }).click();
    await waitFor(async () => (await wireLog()).filter(event => event.kind === 'lookup-delivery-interrupted').length > beforeRetry,
      'the restarted worker performs read-only lookup for the same unresolved save');
    assert.equal(await second.ui.locator('[data-clipper-saved]').count(), 0);
  } finally { await devtools.detach(); }
  await context.close(); context = undefined;
  await rm(fault); await rm(`${fault}.armed`);
  await launch();
  const third = await pageWithOverlay(false);
  await third.ui.getByRole('button', { name: 'Check previous save', exact: true }).click({ timeout });
  await third.ui.getByText('The previous clip was saved. This new draft has not been saved.', { exact: true }).waitFor({ timeout });
  assert.deepEqual(await readFile(savedPath), originalBytes);
  const events = await wireLog();
  assert.equal(events.filter(event => event.kind === 'out-of-fixture-request-blocked').length, 0,
    'The product must not attempt capture access outside the fixture vault');
  const saves = events.filter(event => event.kind === 'request' && event.message.action === 'save_block');
  assert.equal(saves.length, 1, 'Recovery must lookup the original operation without another save dispatch');
  assert.equal(saves[0].message.operation_id, dropped.request.operation_id);
  assert.equal(saves[0].message.vault_path, source);
  assert.equal(saves[0].message.binding_id, bindingId);
  assert.ok(events.some(event => event.kind === 'request' && event.message.action === 'get_save_operation'
    && event.message.operation_id === dropped.request.operation_id));
  const documents = await markdownFiles();
  const cards = documents.filter(item => !/^type: channel$/m.test(item.content));
  assert.equal(cards.length, 1);
  assert.deepEqual(await readFile(cards[0].path), originalBytes);
  const channels = await worker.evaluate(async source => sendNativeMessage({ action: 'list_channels', vault_path: source }), source);
  assert.equal(channels.ok, true, JSON.stringify(channels));
  assert.equal(channels.channels.find(channel => channel.tag === collectionName)?.block_count, 1,
    'The actual native collection reader must associate the sole card with the selected collection');
  const derived = join(run, 'scanner'); await mkdir(derived);
  const browserSnapshot = join(run, 'browser-snapshot.json');
  const scannerJson = await exec(scanner, [source, derived, '2', '--full', '--browser-output', browserSnapshot]);
  await writeFile(join(run, 'scanner-report.json'), scannerJson);
  const scanned = JSON.parse(scannerJson);
  assert.equal(scanned.source_unchanged, true);
  assert.equal(scanned.stable_after_reopen, true);
  for (const cycle of scanned.cycles) {
    const snapshot = cycle.settled.grid_snapshot;
    assert.equal(snapshot.total_blocks, 1);
    assert.equal(snapshot.blocks.length, 1);
    const block = snapshot.blocks[0];
    assert.equal(block.slug, dropped.response.slug);
    assert.equal(block.block_type, 'article');
    assert.equal(block.url, fixtureUrl);
    assert.ok(block.body.includes(selection));
    assert.equal(cycle.settled.collection_rows, 2);
  }
  report.assertions.push('real-native-commit-with-lost-delivery-does-not-show-current-save-success',
    'browser-restart-recovers-original-native-operation-with-one-card-and-unchanged-bytes',
    'production-grid-snapshot-contains-original-selection-source-and-type-after-two-reconciliations');
  // Both editors are mounted in real source tabs at the same URL. Their
  // distinct active scopes must retain different selected material and tags.
  const concurrentUrl = `${fixtureUrl}?two-editors=1`;
  const editorOne = await pageWithOverlay(true, concurrentUrl);
  await editorOne.ui.getByText(selection, { exact: true }).waitFor({ timeout });
  await editorOne.ui.getByRole('button', { name: 'Link', exact: true }).click();
  await editorOne.ui.getByRole('button', { name: `Connect ${collectionName}`, exact: true }).click();
  const editorTwo = await pageWithOverlay(true, concurrentUrl, '#alternate-selection');
  await editorTwo.ui.getByText(otherSelection, { exact: true }).waitFor({ timeout });
  await editorTwo.ui.getByText(otherCollectionName, { exact: true }).hover();
  await editorTwo.ui.getByRole('button', { name: `Connect ${otherCollectionName}`, exact: true }).click();
  await waitFor(() => worker.evaluate(async ({ url, selections, collections }) => {
    const records = Object.values(await chrome.storage.local.get(null)).filter(value => value?.sourceUrl === url && value?.draft);
    return records.length === 2 && selections.every((text, index) => records.some(value =>
      value.draft.state.metadata?.selection === text && value.draft.state.selectedTags?.length === 1
      && value.draft.state.selectedTags[0] === collections[index]));
  }, { url: concurrentUrl, selections: [selection, otherSelection], collections: [collectionName, otherCollectionName] }), 'two independent confirmed editor drafts');
  const firstDrafts = await worker.evaluate(async url => Object.values(await chrome.storage.local.get(null))
    .filter(value => value?.sourceUrl === url && value?.draft), concurrentUrl);
  assert.equal(new Set(firstDrafts.map(value => value.draftId)).size, 2);
  await editorOne.page.close();
  await editorTwo.ui.getByText(otherSelection, { exact: true }).waitFor({ timeout });
  assert.equal(await editorTwo.ui.getByRole('button', { name: 'Content', exact: true }).getAttribute('aria-pressed'), 'true');
  await editorTwo.ui.getByRole('button', { name: 'Save to 1 collection', exact: true }).waitFor({ timeout });
  const draftsAfterClose = await worker.evaluate(async url => Object.values(await chrome.storage.local.get(null))
    .filter(value => value?.sourceUrl === url && value?.draft), concurrentUrl);
  const editorMaterial = records => records.map(value => ({ draftId: value.draftId,
    selection: value.draft.state.metadata?.selection, currentType: value.draft.state.currentType,
    collections: value.draft.state.selectedTags })).sort((a, b) => a.draftId.localeCompare(b.draftId));
  assert.deepEqual(editorMaterial(draftsAfterClose), editorMaterial(firstDrafts));
  assert.deepEqual((await markdownFiles()).sort((a, b) => a.path.localeCompare(b.path)), documents.sort((a, b) => a.path.localeCompare(b.path)),
    'Editing and closing the concurrent fixture must not write source documents');
  assert.equal((await wireLog()).filter(event => event.kind === 'request' && event.message.action === 'save_block').length, 1);
  report.assertions.push('two-live-source-tabs-retain-independent-selected-material-and-collections-after-one-closes');
  report.concurrentEditorDrafts = { distinctDrafts: 2, oneClosed: true, remainingSelection: otherSelection,
    remainingCollection: otherCollectionName, additionalSaveRequests: 0, sourceDocumentsUnchanged: true };
  report.cardRender = await renderCapturedCard({ snapshotPath: browserSnapshot, outputDirectory: run,
    slug: dropped.response.slug, expectedText: selection });
  report.assertions.push('production-grid-renders-the-same-native-source-card-before-and-after-preview-settles');
  Object.assign(report, { ok: true, operationId: dropped.request.operation_id, slug: dropped.response.slug,
    savedPath, savedSha256: digest(originalBytes), browserSnapshot, browserRestarts: 2, serviceWorkerRestarts: 1,
    selectedCollection: collectionName, collectionCardCount: 1,
    sourceTabIds: [first.tabId, second.tabId, third.tabId], visibleTauriCard: false });
  await intervening.close().catch(() => undefined);
} catch (error) {
  report.error = error.stack ?? String(error);
  throw error;
} finally {
  await context?.close();
  await writeFile(join(run, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await rm(profile, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: report.ok, report: join(run, 'report.json') }));
}
