// Real packaged classic worker + CSP + WASM + IndexedDB persistence. OPFS lives
// only in a disposable profile: this does not test OS folders/permissions or Dia.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const argumentsList = process.argv.slice(2);
assert.ok(argumentsList.length === 0 || (argumentsList.length === 2 && argumentsList[0] === '--extension'
  && isAbsolute(argumentsList[1])), 'Usage: node scripts/clipper-worker-smoke.mjs [--extension /absolute/path]');
const extension = argumentsList.length ? argumentsList[1] : join(root, 'build/clipper-extension');
const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8'));
const fixtures = JSON.parse(readFileSync(join(root, 'mine-core/tests/save-fixtures.json'), 'utf8'));
const extensionId = createHash('sha256').update(Buffer.from(manifest.key, 'base64'))
  .digest('hex').slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + Number.parseInt(digit, 16)));
assert.ok(manifest.content_security_policy.extension_pages.includes("'wasm-unsafe-eval'"));
assert.equal(manifest.background.type, undefined, 'the shipped worker must retain classic importScripts semantics');

const temporaryProfile = mkdtempSync(join(tmpdir(), 'mine-clipper-worker-smoke-'));
const evidenceDirectory = join(root, 'output/playwright');
mkdirSync(evidenceDirectory, { recursive: true });
const reportPath = join(evidenceDirectory, `clipper-worker-${process.pid}-${Date.now()}.json`);
const report = { ok: false, extension, extensionId,
  runtimeIdentity: JSON.parse(readFileSync(join(extension, 'dist/runtime-identity.json'), 'utf8')),
  backgroundSha256: createHash('sha256').update(readFileSync(join(extension, 'background.js'))).digest('hex') };
let context;
async function launch() {
  // Full bundled Chromium supports extension workers with the new headless
  // mode; the separate headless-shell binary does not provide this boundary.
  context = await chromium.launchPersistentContext(temporaryProfile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0]
    ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
  assert.equal(worker.url(), `chrome-extension://${extensionId}/background.js`);
  return worker;
}

async function sendBackgroundMessage(page, message) {
  return page.evaluate((payload) => new Promise((resolve) => {
    chrome.runtime.sendMessage({ target: 'background', ...payload }, (response) => {
      resolve({
        response: response ?? null,
        transportError: chrome.runtime.lastError?.message ?? null,
      });
    });
  }), message);
}

async function waitForTargetToClose(devtools, targetId) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { targetInfos } = await devtools.send('Target.getTargets');
    if (!targetInfos.some((target) => target.targetId === targetId)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`CDP target ${targetId} did not close`);
}

async function checkedBackgroundMessage(page, message) {
  const result = await sendBackgroundMessage(page, message);
  assert.equal(result.transportError, null, JSON.stringify(message));
  assert.equal(result.response?.ok, true, JSON.stringify(result.response));
  return result.response;
}

async function restartWorker(page) {
  const devtools = await context.newCDPSession(page);
  try {
    const { targetInfos } = await devtools.send('Target.getTargets');
    const target = targetInfos.find((candidate) => candidate.type === 'service_worker'
      && candidate.url === `chrome-extension://${extensionId}/background.js`);
    assert.ok(target, 'packaged service-worker target is unavailable');
    assert.equal((await devtools.send('Target.closeTarget', { targetId: target.targetId })).success, true);
    await waitForTargetToClose(devtools, target.targetId);
    const result = await sendBackgroundMessage(page, { action: 'standaloneStatus' });
    assert.equal(result.transportError, null);
    assert.equal(typeof result.response?.configured, 'boolean');
    const restarted = await devtools.send('Target.getTargets');
    assert.ok(restarted.targetInfos.some((candidate) => candidate.type === 'service_worker'
      && candidate.url === `chrome-extension://${extensionId}/background.js`), 'standaloneStatus did not wake the worker');
    return context.serviceWorkers().find((candidate) => candidate.url() === `chrome-extension://${extensionId}/background.js`)
      ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
  } finally { await devtools.detach(); }
}

// Open the clipper the way the product does where the overlay cannot run:
// background opens its window for a source tab, and the window receives that
// tab's launch (SPEC_AUDIT_FIXES.md, Ф6). The post read beforehand travels in
// the launch, like the Instagram button's.
async function openClipperWindow(worker, preloaded) {
  const source = await context.newPage();
  await source.goto('about:blank');
  const opened = context.waitForEvent('page', { timeout: 15_000 });
  try {
    await worker.evaluate(async (post) => {
      const tab = (await chrome.tabs.query({})).filter((candidate) => candidate.url === 'about:blank').at(-1);
      if (!tab) throw new Error('No source tab for the clipper window');
      await openClipperUi(tab, { preloaded: post });
    }, preloaded);
  } catch (error) {
    opened.catch(() => undefined);
    throw error;
  }
  const popup = await opened;
  await popup.waitForURL(/\/dist\/index\.html/, { timeout: 15_000 });
  return { popup, source };
}

async function quietTransportPage() {
  const page = await context.newPage();
  await page.route('**/dist/assets/*', (route) => route.abort());
  await page.goto(`chrome-extension://${extensionId}/dist/index.html`);
  return page;
}
try {
  let worker = await launch();
  const results = await worker.evaluate(async (commands) => {
    if (typeof globalThis.MineCore?.call !== 'function') throw new Error('packaged save-core adapter is unavailable');
    const replies = [];
    for (const command of commands) {
      try { replies.push({ ok: true, value: await globalThis.MineCore.call(command) }); }
      catch (error) { replies.push({ ok: false, error: { code: error.code, message: error.message } }); }
    }
    return replies;
  }, fixtures.map(fixture => fixture.command));
  assert.equal(results.length, fixtures.length);
  for (const [index, fixture] of fixtures.entries()) {
    const result = results[index];
    if (fixture.expected !== undefined) assert.deepEqual(result, fixture.expected, fixture.name);
    if (fixture.name.includes('rejected') || fixture.name.startsWith('invalid')) assert.equal(result.ok, false, fixture.name);
    else assert.equal(result.ok, true, `${fixture.name}: ${JSON.stringify(result)}`);
    if (fixture.markdownIncludes) assert.ok(result.value.markdown.includes(fixture.markdownIncludes), fixture.name);
    for (const text of fixture.markdownExcludes ?? []) assert.ok(!result.value.markdown.includes(text), fixture.name);
  }

  // A real FileSystemDirectoryHandle and Blob pass through the actual IDB
  // adapter. A fully closed/reopened browser must recover the prepared payload
  // without fetching media again or selecting a different folder.
  const prepared = await worker.evaluate(async () => {
    const adapter = globalThis.MineStandaloneVault;
    await adapter.storeDirectoryHandle(await navigator.storage.getDirectory());
    const status = await adapter.getStandaloneStatus();
    const request = { operation_id: 'worker-persisted-image', executor_id: 'browser',
      binding_id: status.bindingId, block_type: 'image', title: 'Worker image', body: '',
      image_url: 'data:image/png;base64,aW1hZ2UgYnl0ZXM=', saved_at: '2026-08-31T12:00:00Z' };
    const reply = await adapter.saveStandaloneBlock(request, {
      afterPrepared() { throw new Error('stop after durable preparation'); },
    });
    return { request, reply, status };
  });
  assert.equal(prepared.status.permission, 'granted');
  assert.equal(prepared.reply.outcome, 'not_committed');
  await context.close();
  context = undefined;
  worker = await launch();
  const recovered = await worker.evaluate(async (request) => {
    const adapter = globalThis.MineStandaloneVault;
    const status = await adapter.getStandaloneStatus();
    const lookup = await adapter.lookupOperation(request.operation_id, request.binding_id);
    // Lookup has initialized WASM already. No media network call may be needed.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('unexpected fetch during recovery'); };
    try {
      const reply = await adapter.saveStandaloneBlock({ ...request, operation_mode: 'resume' });
      const duplicate = await adapter.saveStandaloneBlock(request);
      const folder = await adapter.loadDirectoryHandle(request.binding_id);
      const cards = await folder.getDirectoryHandle('Cards');
      const media = await folder.getDirectoryHandle('Media');
      const read = async (directory, name) => (await (await directory.getFileHandle(name)).getFile()).text();
      const names = [];
      for await (const name of cards.keys()) names.push(name);
      return { status, lookup, reply, duplicate, names,
        markdown: await read(cards, 'Worker image.md'), media: await read(media, 'Worker image.png') };
    } finally { globalThis.fetch = originalFetch; }
  }, prepared.request);
  assert.equal(recovered.status.bindingId, prepared.request.binding_id);
  assert.equal(recovered.lookup.resumable, true);
  assert.equal(recovered.reply.outcome, 'committed');
  assert.deepEqual(recovered.duplicate, recovered.reply);
  assert.deepEqual(recovered.names, ['Worker image.md']);
  assert.ok(recovered.markdown.includes('[[Worker image.png]]'));
  assert.equal(recovered.media, 'image bytes');
  await context.close();
  context = undefined;
  worker = await launch();
  const persistedReceipt = await worker.evaluate(async (request) => ({
    lookup: await globalThis.MineStandaloneVault.lookupOperation(request.operation_id, request.binding_id),
    repeated: await globalThis.MineStandaloneVault.saveStandaloneBlock(request),
  }), prepared.request);
  assert.deepEqual(persistedReceipt.lookup, recovered.reply);
  assert.deepEqual(persistedReceipt.repeated, recovered.reply);

  // Use a quiet extension-origin page for the transport checks. Blocking its
  // React bundle prevents mount effects from waking the worker behind the
  // test's back before standaloneStatus does so explicitly below.
  let transportPage = await quietTransportPage();

  // These messages use the shipped listener and real chrome.storage.local.
  // Repeating an acknowledged mutation after worker destruction represents
  // the retry after a lost reply without replacing the storage implementation.
  const draftUrl = 'https://example.test/durable-worker-draft';
  const attached = (await checkedBackgroundMessage(transportPage, {
    action: 'draftAttach', sourceUrl: draftUrl, sourceTabId: 410,
    options: { ownerId: 'first-editor', captureId: 'worker-durable-capture', newCapture: false },
  })).draft;
  const draft = { schemaVersion: 1, revision: 1, draftId: attached.draftId,
    state: { title: 'Confirmed title', selectedTags: ['Collections/Worker collection'],
      screenshotDataUrl: 'data:image/png;base64,AQID', media: ['second', 'first'] } };
  const mutation = { action: 'draftWriteOwned', sourceUrl: draftUrl, draft, expectedRevision: 0,
    ownership: { ownerId: 'first-editor', generation: attached.generation, mutationId: 'confirmed-before-restart' } };
  assert.deepEqual((await checkedBackgroundMessage(transportPage, mutation)).draft, draft);
  worker = await restartWorker(transportPage);
  assert.deepEqual((await checkedBackgroundMessage(transportPage, mutation)).draft, draft);
  const changedRetry = await sendBackgroundMessage(transportPage, { ...mutation,
    draft: { ...draft, state: { ...draft.state, title: 'Changed retry' } } });
  assert.equal(changedRetry.response?.ok, false);
  assert.equal(changedRetry.response?.code, 'invalid_draft');
  await context.close();
  context = undefined;
  worker = await launch();
  transportPage = await quietTransportPage();
  // A new sender tab must discover the previous session's sole capture through
  // the shipped listener, without supplying its old scope or stored draft ID.
  const reopened = (await checkedBackgroundMessage(transportPage, {
    action: 'draftAttach', sourceUrl: draftUrl,
    options: { ownerId: 'reopened-editor', captureId: 'new-browser-candidate', newCapture: false },
  })).draft;
  assert.deepEqual(reopened.draft, draft);
  assert.equal(reopened.generation, attached.generation + 1);
  const staleWrite = await sendBackgroundMessage(transportPage, { ...mutation,
    draft: { ...draft, revision: 2 }, expectedRevision: 1 });
  assert.equal(staleWrite.response?.code, 'draft_owner_replaced');
  const staleClear = await sendBackgroundMessage(transportPage, {
    action: 'draftClearOwned', sourceUrl: draftUrl, draftId: draft.draftId, expectedRevision: 1,
    ownership: mutation.ownership,
  });
  assert.equal(staleClear.response?.code, 'draft_owner_replaced');
  const otherTransportPage = await quietTransportPage();
  const independent = (await checkedBackgroundMessage(otherTransportPage, {
    action: 'draftAttach', sourceUrl: draftUrl, sourceTabId: 411,
    options: { ownerId: 'other-tab', captureId: 'other-capture', newCapture: false },
  })).draft;
  assert.equal(independent.draft, null);
  assert.equal(independent.draftId, 'other-capture');
  await otherTransportPage.close();
  const durableBytes = await worker.evaluate(async (id) => (await chrome.storage.local.get(`mineDurableDraftRecord:${id}`))[`mineDurableDraftRecord:${id}`], draft.draftId);
  assert.deepEqual(durableBytes.draft, draft);

  const setupPageOpened = context.waitForEvent('page');
  const setupReplySent = sendBackgroundMessage(transportPage, {
    action: 'openStandaloneSetup', binding_id: 'worker-smoke-binding',
  });
  const [setupPage, setupTransport] = await Promise.all([setupPageOpened, setupReplySent]);
  assert.equal(setupTransport.transportError, null);
  assert.deepEqual(setupTransport.response, { ok: true });
  await setupPage.waitForLoadState('domcontentloaded');
  const setupUrl = new URL(setupPage.url());
  assert.equal(setupUrl.protocol, 'chrome-extension:');
  assert.equal(setupUrl.host, extensionId);
  assert.equal(setupUrl.pathname, '/dist/index.html');
  assert.equal(setupUrl.searchParams.get('mode'), 'setup');
  assert.equal(setupUrl.searchParams.get('binding_id'), 'worker-smoke-binding');
  await setupPage.close();

  const nativeTransport = await sendBackgroundMessage(transportPage, {
    action: 'nativeMessage', payload: { action: 'get_status' },
  });
  assert.equal(nativeTransport.transportError, null);
  assert.equal(typeof nativeTransport.response, 'object');
  assert.equal(typeof nativeTransport.response?.ok, 'boolean');
  if (!nativeTransport.response.ok) {
    assert.equal(typeof nativeTransport.response.code, 'string');
    assert.doesNotMatch(nativeTransport.response.error ?? '', /message port closed/i);
  }

  // Exercise the shipped React Save button, not a hand-written save request.
  // Seed the existing preloaded-extraction entry point; request construction,
  // timestamp, pinning, messaging, WASM and file publication remain real.
  await worker.evaluate(async () => {
    const collection = await globalThis.MineStandaloneVault.createStandaloneChannel('Worker collection');
    if (!collection.ok) throw new Error(JSON.stringify(collection));
    const status = await globalThis.MineStandaloneVault.getStandaloneStatus();
    await chrome.storage.local.set({ mineSaveDestination: { executor: 'browser', bindingId: status.bindingId } });
  });
  const { popup, source: popupSource } = await openClipperWindow(worker, {
    metadata: { url: 'https://example.test/worker-ui-article', title: 'Worker UI article',
      description: 'UI capture regression', image: null, author: null, ogType: 'article',
      favicon: null, selection: '', detectedType: 'article', isArticle: true },
    article: { title: 'Worker UI article', content: 'Saved through the real popup button.',
      byline: null, excerpt: 'UI capture regression' },
  });
  try {
    await popup.getByRole('button', { name: 'Connect Worker collection', exact: true }).click({ timeout: 15_000 });
    await popup.getByRole('button', { name: 'Save to 1 collection', exact: true }).click({ timeout: 15_000 });
    await popup.locator('[data-clipper-saved]').waitFor({ state: 'visible', timeout: 15_000 });
  } catch (error) {
    throw new Error(`Packaged popup Save did not commit: ${await popup.locator('body').innerText()}`, { cause: error });
  }
  const uiCapture = await worker.evaluate(async () => {
    const folder = await globalThis.MineStandaloneVault.loadDirectoryHandle();
    const cards = await folder.getDirectoryHandle('Cards');
    const markdown = await (await (await cards.getFileHandle('Worker UI article.md')).getFile()).text();
    const collections = await folder.getDirectoryHandle('Collections');
    const collectionMarkdown = await (await (await collections.getFileHandle('Worker collection.md')).getFile()).text();
    const channels = await globalThis.MineStandaloneVault.listStandaloneChannels();
    const stored = await chrome.storage.local.get(null);
    return { markdown, collectionMarkdown, channels,
      pending: Object.keys(stored).filter(key => key.startsWith('minePendingSaveOperation:')),
      clipDrafts: Object.values(stored).filter(value => value?.draft?.state?.metadata?.url === 'https://example.test/worker-ui-article') };
  });
  assert.ok(uiCapture.markdown.includes('Saved through the real popup button.'));
  assert.ok(uiCapture.markdown.includes('https://example.test/worker-ui-article'));
  // A card names its collection the way the app does: by the page's name
  // when it is unique (SPEC_AUDIT_FIXES.md, А3.12).
  assert.ok(uiCapture.markdown.includes('[[Worker collection]]'));
  assert.ok(uiCapture.collectionMarkdown.includes('type: channel'));
  assert.ok(uiCapture.channels.channels.some(channel => channel.tag === 'Worker collection' && channel.block_count === 1));
  assert.deepEqual(uiCapture.pending, []);
  assert.deepEqual(uiCapture.clipDrafts, []);
  await popup.close();
  await popupSource.close();

  // Fail only the autosave boundary. The popup, Chrome storage, operation
  // journal, WASM executor and file publication still execute their real code.
  await worker.evaluate(async () => {
    const sourceUrl = 'https://example.test/worker-ui-autosave-recovery';
    globalThis.__mineSmokeDraftStore = globalThis.MineDraftStore;
    globalThis.__mineSmokeAutosaveFailures = 0;
    globalThis.MineDraftStore = { ...globalThis.MineDraftStore,
      async writeOwned(url, ...argumentsList) {
        if (url === sourceUrl) {
          globalThis.__mineSmokeAutosaveFailures += 1;
          throw Object.assign(new Error('injected autosave failure'), { code: 'draft_storage_failed' });
        }
        return globalThis.__mineSmokeDraftStore.writeOwned(url, ...argumentsList);
      },
    };
  });
  const faultUrl = 'https://example.test/worker-ui-autosave-recovery';
  const { popup: faultPopup } = await openClipperWindow(worker, {
    metadata: { url: faultUrl, title: 'Worker UI autosave recovery',
      description: 'Autosave failure regression', image: null, author: null, ogType: 'article',
      favicon: null, selection: '', detectedType: 'article', isArticle: true },
    article: { title: 'Worker UI autosave recovery', content: 'Visible edits survive autosave failure and Save commits them.',
      byline: null, excerpt: 'Autosave failure regression' },
  });
  try {
    await faultPopup.getByText('Edits are kept in this open clipper. Save will store the clip shown here.', { exact: true })
      .waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(await faultPopup.locator('[data-clipper-save-error]').count(), 0);
    assert.doesNotMatch(await faultPopup.locator('body').innerText(), /injected autosave failure|draft_storage_failed/);
    await faultPopup.getByRole('button', { name: 'Connect Worker collection', exact: true }).click({ timeout: 15_000 });
    await faultPopup.getByRole('button', { name: 'Save to 1 collection', exact: true }).click({ timeout: 15_000 });
    await faultPopup.locator('[data-clipper-saved]').waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(await faultPopup.locator('[data-clipper-save-error]').count(), 0);
  } catch (error) {
    throw new Error(`Packaged popup could not save after autosave failure: ${await faultPopup.locator('body').innerText()}`, { cause: error });
  }
  const faultCapture = await worker.evaluate(async () => {
    const folder = await globalThis.MineStandaloneVault.loadDirectoryHandle();
    const cards = await folder.getDirectoryHandle('Cards');
    const markdown = await (await (await cards.getFileHandle('Worker UI autosave recovery.md')).getFile()).text();
    const stored = await chrome.storage.local.get(null);
    const operations = Object.entries(stored).filter(([key]) => key.startsWith('minePendingSaveOperation:'));
    const operation = operations[0]?.[1];
    const lookup = operation ? await globalThis.MineStandaloneVault.lookupOperation(operation.id, operation.bindingId) : null;
    const failures = globalThis.__mineSmokeAutosaveFailures;
    globalThis.MineDraftStore = globalThis.__mineSmokeDraftStore;
    delete globalThis.__mineSmokeDraftStore;
    delete globalThis.__mineSmokeAutosaveFailures;
    return { markdown, operations, lookup, failures,
      drafts: Object.entries(stored).filter(([key, value]) => key.startsWith('mineDurableDraftRecord:')
        && value?.sourceUrl === 'https://example.test/worker-ui-autosave-recovery').map(([, value]) => value) };
  });
  assert.ok(faultCapture.failures > 0, 'autosave fault must actually reach the shipped worker listener');
  assert.ok(faultCapture.markdown.includes('Visible edits survive autosave failure and Save commits them.'));
  assert.ok(faultCapture.markdown.includes('https://example.test/worker-ui-autosave-recovery'));
  assert.ok(faultCapture.markdown.includes('[[Worker collection]]'));
  assert.equal(faultCapture.operations.length, 1, 'failed draft cleanup retains the original committed recovery receipt');
  assert.equal(faultCapture.operations[0][1].terminalResult.outcome, 'committed');
  assert.deepEqual(faultCapture.lookup, faultCapture.operations[0][1].terminalResult);
  assert.equal(faultCapture.drafts.length, 1);
  assert.equal(faultCapture.drafts[0].draft, null, 'failed autosave must not invent a confirmed draft edition');
  await faultPopup.close();

  const devtools = await context.newCDPSession(transportPage);
  const { targetInfos } = await devtools.send('Target.getTargets');
  const serviceWorkerTarget = targetInfos.find((target) =>
    target.type === 'service_worker' && target.url === worker.url());
  assert.ok(serviceWorkerTarget, 'packaged service-worker target is unavailable');
  const closeResult = await devtools.send('Target.closeTarget', {
    targetId: serviceWorkerTarget.targetId,
  });
  assert.equal(closeResult.success, true);
  await waitForTargetToClose(devtools, serviceWorkerTarget.targetId);
  const statusTransport = await sendBackgroundMessage(transportPage, { action: 'standaloneStatus' });
  assert.equal(statusTransport.transportError, null);
  assert.equal(typeof statusTransport.response?.configured, 'boolean');
  const restartedTargets = await devtools.send('Target.getTargets');
  const restartedWorkerTarget = restartedTargets.targetInfos.find((target) =>
    target.type === 'service_worker' && target.url === `chrome-extension://${extensionId}/background.js`);
  assert.ok(restartedWorkerTarget, 'standaloneStatus did not wake the packaged service worker');
  await devtools.detach();
  await transportPage.close();
  await context.close();
  context = undefined;
  worker = await launch();
  const finalCapture = await worker.evaluate(async () => {
    const folder = await globalThis.MineStandaloneVault.loadDirectoryHandle();
    const cards = await folder.getDirectoryHandle('Cards');
    const collections = await folder.getDirectoryHandle('Collections');
    const read = async (directory, name) => (await (await directory.getFileHandle(name)).getFile()).text();
    const names = [];
    for await (const name of cards.keys()) names.push(name);
    const stored = await chrome.storage.local.get(null);
    return { markdown: await read(cards, 'Worker UI article.md'),
      faultMarkdown: await read(cards, 'Worker UI autosave recovery.md'),
      collectionMarkdown: await read(collections, 'Worker collection.md'), names: names.sort(),
      pending: Object.keys(stored).filter(key => key.startsWith('minePendingSaveOperation:')) };
  });
  assert.equal(finalCapture.markdown, uiCapture.markdown);
  assert.equal(finalCapture.faultMarkdown, faultCapture.markdown);
  assert.equal(finalCapture.collectionMarkdown, uiCapture.collectionMarkdown);
  assert.deepEqual(finalCapture.names, ['Worker UI article.md', 'Worker UI autosave recovery.md', 'Worker image.md']);
  assert.deepEqual(finalCapture.pending, [faultCapture.operations[0][0]]);
  Object.assign(report, { ok: true, scope: 'chromium-extension-worker-wasm',
    fixtures: fixtures.length, headless: true, temporaryProfile: true,
    persistedHandleBlobReceipt: true, browserRestarts: 4, popupSaveToFile: true,
    popupSelectedCollectionToFile: true, chromeStorageDraftRetry: true,
    draftTransportBrowserReopen: true, staleDraftOwnerRejected: true, independentTabCaptures: true,
    savedFileStableAfterBrowserReopen: true,
    popupSaveAfterAutosaveFailure: true, committedReceiptRetainedAfterAutosaveFailure: true,
    standaloneSetupTransport: true, nativeStatusTransport: true, serviceWorkerRestarts: 2,
    filesystem: 'OPFS-not-OS-folder' });
} catch (error) {
  report.error = error.stack ?? String(error);
  throw error;
} finally {
  await context?.close();
  // This path was allocated above for this process, never a user profile.
  rmSync(temporaryProfile, { recursive: true, force: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ok: report.ok, report: reportPath }));
}
