// Real packaged classic worker + CSP + WASM + IndexedDB persistence. OPFS lives
// only in a disposable profile: this does not test OS folders/permissions or Dia.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const extension = join(root, 'extension');
const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8'));
const fixtures = JSON.parse(readFileSync(join(root, 'mine-core/tests/save-fixtures.json'), 'utf8'));
const extensionId = createHash('sha256').update(Buffer.from(manifest.key, 'base64'))
  .digest('hex').slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + Number.parseInt(digit, 16)));
assert.ok(manifest.content_security_policy.extension_pages.includes("'wasm-unsafe-eval'"));
assert.equal(manifest.background.type, undefined, 'the shipped worker must retain classic importScripts semantics');

const temporaryProfile = mkdtempSync(join(tmpdir(), 'mine-clipper-worker-smoke-'));
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
  assert.ok(recovered.markdown.includes('[[Media/Worker image.png]]'));
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
  const transportPage = await context.newPage();
  await transportPage.route('**/dist/assets/*', (route) => route.abort());
  await transportPage.goto(`chrome-extension://${extensionId}/dist/index.html`);

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
    await chrome.storage.session.set({ preloadedClipData: {
      metadata: { url: 'https://example.test/worker-ui-article', title: 'Worker UI article',
        description: 'UI capture regression', image: null, author: null, ogType: 'article',
        favicon: null, selection: '', detectedType: 'article', isArticle: true },
      article: { title: 'Worker UI article', content: 'Saved through the real popup button.',
        byline: null, excerpt: 'UI capture regression' },
    } });
  });
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/dist/index.html`);
  await popup.getByRole('button', { name: 'Save', exact: true }).click({ timeout: 15_000 });
  try {
    await popup.locator('[data-clipper-saved]').waitFor({ state: 'visible', timeout: 15_000 });
  } catch (error) {
    throw new Error(`Packaged popup Save did not commit: ${await popup.locator('body').innerText()}`, { cause: error });
  }
  const uiCapture = await worker.evaluate(async () => {
    const folder = await globalThis.MineStandaloneVault.loadDirectoryHandle();
    const cards = await folder.getDirectoryHandle('Cards');
    const markdown = await (await (await cards.getFileHandle('Worker UI article.md')).getFile()).text();
    const stored = await chrome.storage.local.get(null);
    return { markdown, pending: Object.keys(stored).filter(key => key.startsWith('minePendingSaveOperation:')) };
  });
  assert.ok(uiCapture.markdown.includes('Saved through the real popup button.'));
  assert.ok(uiCapture.markdown.includes('https://example.test/worker-ui-article'));
  assert.deepEqual(uiCapture.pending, []);

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
  console.log(JSON.stringify({ ok: true, scope: 'chromium-extension-worker-wasm', extensionId,
    fixtures: fixtures.length, headless: true, temporaryProfile: true,
    persistedHandleBlobReceipt: true, browserRestarts: 2, popupSaveToFile: true,
    standaloneSetupTransport: true, nativeStatusTransport: true, serviceWorkerRestarts: 1,
    filesystem: 'OPFS-not-OS-folder' }));
} finally {
  await context?.close();
  // This path was allocated above for this process, never a user profile.
  rmSync(temporaryProfile, { recursive: true, force: true });
}
