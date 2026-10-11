// Real packaged classic worker + CSP + WASM + IndexedDB persistence. OPFS lives
// only in a disposable profile: this does not test OS folders/permissions or Dia.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
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
// Two pages of a local site in the same tab, to check the in-page overlay of
// the built extension the way a person meets it (SPEC_CLIPPER.md, «Доработки
// после живого просмотра», Р5 to Р10): the page under it keeps working, a new
// document brings it back with the same clip, Screenshot takes the page shown
// now for the card of the page the clip was opened on, the header moves it,
// the corners resize it, and the window keeps it whole.
const SITE_PAGES = {
  '/a': { title: 'Page A', colour: 'rgb(255, 0, 0)' },
  '/b': { title: 'Page B', colour: 'rgb(0, 0, 255)' },
};

function sitePage(path) {
  const { title, colour } = SITE_PAGES[path];
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>html,body{margin:0;background:${colour};min-height:3000px}#press{position:fixed;left:20px;top:20px}
#field{position:fixed;left:20px;top:80px}#next{position:fixed;left:20px;top:140px;color:#fff}</style></head>
<body><button id="press" type="button">Pressed 0</button><input id="field"><a id="next" href="/b">Next page</a>
<script>let presses=0;document.getElementById('press').addEventListener('click',(event)=>{presses+=1;event.currentTarget.textContent='Pressed '+presses;});</script>
</body></html>`;
}

async function startSite() {
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    if (!SITE_PAGES[path]) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(sitePage(path));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

// Wherever the panel stands, it keeps 16 px from every edge of the window
// (Р10, 11.10.2026).
const OVERLAY_INSET = 16;

async function panelBox(page) {
  const box = await page.locator('[data-mine-clipper-panel]').boundingBox();
  assert.ok(box, 'the overlay panel is not on the page');
  return box;
}

async function dragBy(page, from, dx, dy) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 4 });
  await page.mouse.up();
}

async function checkOverlayAcrossPages(worker) {
  const { server, origin } = await startSite();
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${origin}/a`);
    await worker.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === url);
      if (!tab) throw new Error('No tab for the local page');
      await chrome.tabs.update(tab.id, { active: true });
      await openClipperUi(tab);
    }, `${origin}/a`);
    const panel = page.locator('[data-mine-clipper-panel]');
    await panel.waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByRole('button', { name: 'Connect Worker collection', exact: true }).waitFor({ timeout: 15_000 });

    // Р5: the overlay does not take the keyboard, and the page under it takes
    // clicks, typing, Escape and scrolling.
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-mine-clipper-overlay') ?? false), false);
    assert.equal(await page.evaluate(() => document.elementFromPoint(30, 30)?.id), 'press');
    await page.mouse.click(40, 30);
    assert.equal(await page.locator('#press').textContent(), 'Pressed 1');
    await page.locator('#field').click();
    await page.keyboard.type('typed on the page');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#field').inputValue(), 'typed on the page');
    await page.mouse.move(300, 600);
    await page.mouse.wheel(0, 400);
    await page.waitForFunction(() => window.scrollY > 0);
    assert.equal(await panel.isVisible(), true, 'the overlay closed under the page');

    // Р10: the header moves it, the corners resize it, both are kept.
    const start = await panelBox(page);
    const header = await page.locator('[data-clipper-drag-handle]').boundingBox();
    await dragBy(page, { x: header.x + header.width - 100, y: header.y + header.height / 2 }, -400, 120);
    const moved = await panelBox(page);
    assert.ok(Math.abs(moved.x - (start.x - 400)) <= 1 && Math.abs(moved.y - (start.y + 120)) <= 1, JSON.stringify({ start, moved }));
    const corner = await page.locator('[data-clipper-resize-handle="bottom-right"]').boundingBox();
    await dragBy(page, { x: corner.x + corner.width / 2, y: corner.y + corner.height / 2 }, 100, 60);
    const grown = await panelBox(page);
    assert.ok(Math.abs(grown.width - (moved.width + 100)) <= 1 && Math.abs(grown.height - (moved.height + 60)) <= 1, JSON.stringify({ moved, grown }));
    // The top left corner grows it up and left; the bottom right corner stays.
    const topLeft = await page.locator('[data-clipper-resize-handle="top-left"]').boundingBox();
    await dragBy(page, { x: topLeft.x + topLeft.width / 2, y: topLeft.y + topLeft.height / 2 }, -60, -40);
    const sized = await panelBox(page);
    assert.ok(Math.abs(sized.x - (grown.x - 60)) <= 1 && Math.abs(sized.y - (grown.y - 40)) <= 1
      && Math.abs(sized.x + sized.width - (grown.x + grown.width)) <= 1
      && Math.abs(sized.y + sized.height - (grown.y + grown.height)) <= 1, JSON.stringify({ grown, sized }));
    const kept = await worker.evaluate(async () => (await chrome.storage.local.get('mineOverlayBounds')).mineOverlayBounds);
    assert.ok(Math.abs(kept.left - sized.x) <= 1 && Math.abs(kept.top - sized.y) <= 1 && Math.abs(kept.width - sized.width) <= 1, JSON.stringify(kept));
    // The window shrinks: the panel stays whole in it, 16 px in from its
    // edges; it grows back: the panel returns.
    await page.setViewportSize({ width: 640, height: 500 });
    await page.waitForFunction((inset) => {
      const box = document.querySelector('[data-mine-clipper-overlay]')?.shadowRoot?.querySelector('[data-mine-clipper-panel]')?.getBoundingClientRect();
      return box && box.left >= inset - 0.5 && box.top >= inset - 0.5
        && box.right <= window.innerWidth - inset + 0.5 && box.bottom <= window.innerHeight - inset + 0.5;
    }, OVERLAY_INSET);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForFunction((expected) => {
      const box = document.querySelector('[data-mine-clipper-overlay]')?.shadowRoot?.querySelector('[data-mine-clipper-panel]')?.getBoundingClientRect();
      return box && Math.abs(box.left - expected.x) <= 1 && Math.abs(box.top - expected.y) <= 1 && Math.abs(box.width - expected.width) <= 1;
    }, sized);

    // The clip gets a collection and the Link type, then the page changes.
    await page.getByRole('button', { name: 'Connect Worker collection', exact: true }).click();
    await page.getByRole('tab', { name: 'Link', exact: true }).click();
    // The page changes right after the last edit: what is pending reaches
    // background as the document goes.
    await page.locator('#next').click();
    await page.waitForURL(`${origin}/b`);

    // Р7: the new document opens the overlay with the same clip, where it was.
    await page.getByRole('button', { name: 'Save to 1 collection', exact: true }).waitFor({ timeout: 15_000 });
    assert.equal(await page.getByRole('tab', { name: 'Link', exact: true }).getAttribute('aria-selected'), 'true');
    assert.ok((await panel.textContent()).includes(`${origin}/a`), 'the restored clip lost its page');
    const restored = await panelBox(page);
    assert.ok(Math.abs(restored.x - sized.x) <= 1 && Math.abs(restored.y - sized.y) <= 1, JSON.stringify({ sized, restored }));
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-mine-clipper-overlay') ?? false), false);

    // Р9: Screenshot takes page B for the card of page A.
    await page.getByRole('tab', { name: 'Screenshot', exact: true }).click();
    await page.getByRole('button', { name: 'Retake', exact: true }).click();
    // Save waits for the frame being taken (В4.5).
    await page.getByRole('button', { name: 'Save to 1 collection', exact: true }).click();
    await page.locator('[data-clipper-saved]').waitFor({ state: 'visible', timeout: 15_000 });

    const saved = await worker.evaluate(async () => {
      const folder = await globalThis.MineStandaloneVault.loadDirectoryHandle();
      const cards = await folder.getDirectoryHandle('Cards');
      const media = await folder.getDirectoryHandle('Media');
      const markdown = await (await (await cards.getFileHandle('Page A.md')).getFile()).text();
      const names = [];
      for await (const name of media.keys()) names.push(name);
      const image = names.find((name) => name.startsWith('Page A.'));
      const bitmap = await createImageBitmap(await (await media.getFileHandle(image)).getFile());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const draw = canvas.getContext('2d');
      draw.drawImage(bitmap, 0, 0);
      const [red, green, blue] = draw.getImageData(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1).data;
      // The Save took the clip away; background may still be writing that.
      let session = await chrome.storage.session.get(null);
      for (let attempt = 0; attempt < 40 && Object.keys(session).some((key) => key.startsWith('mineOpenClip:')); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        session = await chrome.storage.session.get(null);
      }
      return { markdown, colour: { red, green, blue },
        openClips: Object.keys(session).filter((key) => key.startsWith('mineOpenClip:')), tabs: session.mineOpenClipTabs ?? [] };
    });
    assert.ok(saved.markdown.includes(`${origin}/a`), saved.markdown);
    assert.ok(saved.markdown.includes('[[Worker collection]]'), saved.markdown);
    assert.ok(saved.colour.blue > 200 && saved.colour.red < 60, `the screenshot is not of page B: ${JSON.stringify(saved.colour)}`);
    // Ч12: the Save leaves nothing of the clip for the tab.
    assert.deepEqual(saved.openClips, []);
    assert.deepEqual(saved.tabs, []);
  } finally {
    await page.close();
    // The browser keeps its connections open; the site goes with them.
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

// Р10: the header drags by the window chrome's rule, the space's name
// included. A long name leaves no empty part of the header; a press on it
// that travels past 4 px moves the panel and opens nothing, a press without
// it and a click open the space menu. The space comes from the kept
// destination; Mine need not answer for the header to show it. The name is
// the one of the live acceptance of 11.10.2026: in a 360 px panel it ends in
// an ellipsis before its chevron, short of "…", and a drag to the window's
// edge leaves the panel 16 px in from it.
const LONG_SPACE = '/Users/worker/Spaces/Mine. Длинное название. Прям вот легендарное';

/** The header's parts with a long name, measured in the page. */
async function headerLayout(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-mine-clipper-overlay]').shadowRoot;
    const row = root.querySelector('[data-clipper-space-row]');
    const name = row.querySelector('[data-clipper-space-switcher]');
    const label = name.firstElementChild.firstElementChild;
    const box = (element) => {
      const { left, right, width } = element.getBoundingClientRect();
      return { left, right, width };
    };
    return {
      name: box(name), label: box(label), chevron: box(name.querySelector('svg')),
      more: box(row.querySelector('[data-clipper-overflow-trigger]')),
      close: box(row.querySelector('[aria-label="Close"]')),
      text: label.textContent,
      cut: label.scrollWidth > label.clientWidth,
      textOverflow: getComputedStyle(label).textOverflow,
    };
  });
}

async function checkHeaderDragBySpaceName(worker) {
  const { server, origin } = await startSite();
  const page = await context.newPage();
  try {
    // The panel opens in its default place at 360 px, where the name does not fit.
    await worker.evaluate(async (space) => {
      await chrome.storage.local.remove('mineOverlayBounds');
      await chrome.storage.local.set({
        mineSaveDestination: { executor: 'native', vaultPath: space, bindingId: null },
        mineKnownVaults: [space, '/Users/worker/Spaces/Journal'],
      });
    }, LONG_SPACE);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${origin}/a`);
    await worker.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === url);
      if (!tab) throw new Error('No tab for the local page');
      await chrome.tabs.update(tab.id, { active: true });
      await openClipperUi(tab);
    }, `${origin}/a`);
    const name = page.locator('[data-clipper-space-switcher]');
    await name.waitFor({ state: 'visible', timeout: 15_000 });
    const search = page.getByRole('textbox', { name: 'Search spaces', exact: true });
    const header = await page.locator('[data-clipper-space-row]').boundingBox();
    const nameBox = await name.boundingBox();
    assert.ok(nameBox.width > header.width / 2, `the name does not fill the header: ${JSON.stringify({ header, nameBox })}`);
    const centre = { x: nameBox.x + nameBox.width / 2, y: nameBox.y + nameBox.height / 2 };

    // The long name ends in an ellipsis, then its chevron, then "…" and the
    // close button: it runs over none of them.
    const layout = await headerLayout(page);
    assert.equal(layout.text, 'Mine. Длинное название. Прям вот легендарное');
    assert.ok(layout.cut && layout.textOverflow === 'ellipsis', `the long name is not cut with an ellipsis: ${JSON.stringify(layout)}`);
    assert.ok(layout.label.right < layout.more.left, `the name runs into "…": ${JSON.stringify(layout)}`);
    assert.ok(layout.label.right <= layout.chevron.left + 0.5 && layout.chevron.width > 0
      && layout.chevron.right <= layout.name.right + 0.5, `the name runs over its chevron: ${JSON.stringify(layout)}`);
    assert.ok(layout.name.right <= layout.more.left + 0.5 && layout.more.right <= layout.close.left + 0.5,
      `the name's button runs into the header's buttons: ${JSON.stringify(layout)}`);

    // Past the threshold: the panel follows the pointer, the menu stays shut.
    const before = await panelBox(page);
    await dragBy(page, centre, -200, 30);
    const after = await panelBox(page);
    const expected = {
      x: Math.min(Math.max(before.x - 200, OVERLAY_INSET), 1280 - OVERLAY_INSET - before.width),
      y: Math.min(Math.max(before.y + 30, OVERLAY_INSET), 900 - OVERLAY_INSET - before.height),
    };
    assert.ok(Math.abs(after.x - expected.x) <= 1 && Math.abs(after.y - expected.y) <= 1, JSON.stringify({ before, after, expected }));
    assert.equal(await search.count(), 0, 'the space menu opened after a drag by the name');
    assert.equal(await name.getAttribute('aria-expanded'), 'false');
    const kept = await worker.evaluate(async () => (await chrome.storage.local.get('mineOverlayBounds')).mineOverlayBounds);
    assert.ok(Math.abs(kept.left - after.x) <= 1 && Math.abs(kept.top - after.y) <= 1, JSON.stringify(kept));

    // Below the threshold: the panel stays, the press is a click and opens the menu.
    const moved = await name.boundingBox();
    const pressAt = { x: moved.x + moved.width / 2, y: moved.y + moved.height / 2 };
    await page.mouse.move(pressAt.x, pressAt.y);
    await page.mouse.down();
    await page.mouse.move(pressAt.x + 2, pressAt.y + 1);
    await page.mouse.up();
    await search.waitFor({ state: 'visible', timeout: 5_000 });
    const still = await panelBox(page);
    assert.ok(Math.abs(still.x - after.x) <= 0.5 && Math.abs(still.y - after.y) <= 0.5, JSON.stringify({ after, still }));
    await page.keyboard.press('Escape');
    await search.waitFor({ state: 'detached', timeout: 5_000 });

    // A plain click opens it too.
    await name.click();
    await search.waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal(await name.getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape');
    await search.waitFor({ state: 'detached', timeout: 5_000 });

    // Dragged by the name to the window's top left corner and then to its
    // bottom right one, the panel stops 16 px from the edges, as its default
    // place stands, and that place is kept.
    const toTopLeft = await name.boundingBox();
    await dragBy(page, { x: toTopLeft.x + toTopLeft.width / 2, y: toTopLeft.y + toTopLeft.height / 2 },
      2 - (toTopLeft.x + toTopLeft.width / 2), 2 - (toTopLeft.y + toTopLeft.height / 2));
    const topLeft = await panelBox(page);
    assert.ok(Math.abs(topLeft.x - OVERLAY_INSET) <= 0.5 && Math.abs(topLeft.y - OVERLAY_INSET) <= 0.5,
      `the panel does not stand 16 px from the top left edges: ${JSON.stringify(topLeft)}`);
    const toBottomRight = await name.boundingBox();
    await dragBy(page, { x: toBottomRight.x + toBottomRight.width / 2, y: toBottomRight.y + toBottomRight.height / 2 },
      1278 - (toBottomRight.x + toBottomRight.width / 2), 898 - (toBottomRight.y + toBottomRight.height / 2));
    const bottomRight = await panelBox(page);
    assert.ok(Math.abs(bottomRight.x + bottomRight.width - (1280 - OVERLAY_INSET)) <= 0.5
      && Math.abs(bottomRight.y + bottomRight.height - (900 - OVERLAY_INSET)) <= 0.5,
      `the panel does not stand 16 px from the bottom right edges: ${JSON.stringify(bottomRight)}`);
    assert.equal(await search.count(), 0, 'the space menu opened after a drag to the edge');
    const keptAtEdge = await worker.evaluate(async () => (await chrome.storage.local.get('mineOverlayBounds')).mineOverlayBounds);
    assert.ok(Math.abs(keptAtEdge.left - bottomRight.x) <= 1 && Math.abs(keptAtEdge.top - bottomRight.y) <= 1, JSON.stringify(keptAtEdge));
  } finally {
    await page.close();
    await worker.evaluate(async () => chrome.storage.local.remove(['mineSaveDestination', 'mineKnownVaults', 'mineOverlayBounds']));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

// A collection exists only as its page (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md,
// К1, К7, К9). The browser folder lists the pages only, not a name a card
// links without one; a Save into a collection whose page was deleted after
// the clipper opened writes nothing, says why under the collection list, and
// a Save again saves the clip without it.
async function checkCollectionsArePages(worker) {
  const listed = await worker.evaluate(async () => {
    const adapter = globalThis.MineStandaloneVault;
    const created = await adapter.createStandaloneChannel('Vanishing');
    if (!created.ok) throw new Error(JSON.stringify(created));
    const folder = await adapter.loadDirectoryHandle();
    const cards = await folder.getDirectoryHandle('Cards');
    const loose = await (await cards.getFileHandle('Loose note.md', { create: true })).createWritable();
    await loose.write('---\nMine Collections:\n  - "[[Pageless]]"\n---\nA note linking a name without a page.\n');
    await loose.close();
    const status = await adapter.getStandaloneStatus();
    await chrome.storage.local.set({ mineSaveDestination: { executor: 'browser', bindingId: status.bindingId } });
    return (await adapter.listStandaloneChannels()).channels.map((channel) => channel.tag);
  });
  assert.ok(listed.includes('Vanishing') && listed.includes('Worker collection'), JSON.stringify(listed));
  assert.ok(!listed.includes('Pageless'), `a name without a page is listed: ${JSON.stringify(listed)}`);

  const cardNames = () => worker.evaluate(async () => {
    const folder = await globalThis.MineStandaloneVault.loadDirectoryHandle();
    const names = [];
    for await (const name of (await folder.getDirectoryHandle('Cards')).keys()) names.push(name);
    return names.sort();
  });
  const cardsBefore = await cardNames();
  const { popup, source } = await openClipperWindow(worker, {
    metadata: { url: 'https://example.test/vanishing', title: 'Vanishing check',
      description: null, image: null, author: null, ogType: 'article',
      favicon: null, selection: '', detectedType: 'article', isArticle: true },
    article: { title: 'Vanishing check', content: 'A clip whose collection page goes.', byline: null, excerpt: null },
  });
  try {
    await popup.getByRole('button', { name: 'Connect Vanishing', exact: true }).click({ timeout: 15_000 });
    // The page goes after the clipper opened, as a deletion in Finder would.
    await worker.evaluate(async () => {
      const folder = await globalThis.MineStandaloneVault.loadDirectoryHandle();
      await (await folder.getDirectoryHandle('Collections')).removeEntry('Vanishing.md');
    });
    await popup.getByRole('button', { name: 'Save to 1 collection', exact: true }).click({ timeout: 15_000 });
    const reason = popup.locator('[data-clipper-collection-error]');
    await reason.waitFor({ state: 'visible', timeout: 15_000 });
    assert.ok((await reason.textContent()).includes('“Vanishing”'), await reason.textContent());
    assert.equal(await popup.locator('[data-clipper-save-error]').count(), 0);
    assert.deepEqual(await cardNames(), cardsBefore, 'a refused Save wrote a card');
    // The list is read again without it, and the clip is still open.
    await popup.getByRole('button', { name: 'Connect Vanishing', exact: true }).waitFor({ state: 'detached', timeout: 15_000 });
    await popup.getByRole('button', { name: 'Save', exact: true }).click({ timeout: 15_000 });
    await popup.locator('[data-clipper-saved]').waitFor({ state: 'visible', timeout: 15_000 });
  } catch (error) {
    throw new Error(`Save into a collection without a page: ${await popup.locator('body').innerText()}`, { cause: error });
  } finally {
    await popup.close();
    await source.close();
    await worker.evaluate(async () => chrome.storage.local.remove(['mineSaveDestination']));
  }
  const saved = await worker.evaluate(async () => {
    const folder = await globalThis.MineStandaloneVault.loadDirectoryHandle();
    const cards = await folder.getDirectoryHandle('Cards');
    return (await (await cards.getFileHandle('Vanishing check.md')).getFile()).text();
  });
  assert.ok(saved.includes('A clip whose collection page goes.'), saved);
  assert.ok(!saved.includes('[[Vanishing]]'), saved);
}

try {
  let worker = await launch();
  const results = await worker.evaluate(async (commands) => {
    if (typeof globalThis.MineCore?.call !== 'function') throw new Error('packaged save-core adapter is unavailable');
    const replies = [];
    for (const command of commands) {
      try { replies.push({ ok: true, value: await globalThis.MineCore.call(command) }); }
      catch (error) {
        replies.push({ ok: false, error: { code: error.code, message: error.message,
          ...(typeof error.collection === 'string' ? { collection: error.collection } : {}) } });
      }
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

  // The shipped listener answers again once its worker restarts. A clip is
  // kept only in an open clipper, so nothing about it outlives the restart
  // (SPEC_CLIPPER_DRAFTS_REMOVAL.md, Ч1).
  worker = await restartWorker(transportPage);

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
      drafts: Object.keys(stored).filter(key => key.startsWith('mineDurableDraft')) };
  });
  assert.ok(uiCapture.markdown.includes('Saved through the real popup button.'));
  assert.ok(uiCapture.markdown.includes('https://example.test/worker-ui-article'));
  // A card names its collection the way the app does: by the page's name
  // when it is unique (SPEC_AUDIT_FIXES.md, А3.12).
  assert.ok(uiCapture.markdown.includes('[[Worker collection]]'));
  assert.ok(uiCapture.collectionMarkdown.includes('type: channel'));
  assert.ok(uiCapture.channels.channels.some(channel => channel.tag === 'Worker collection' && channel.block_count === 1));
  // The committed save leaves no record, and no draft was ever written (Ч1, Ч4).
  assert.deepEqual(uiCapture.pending, []);
  assert.deepEqual(uiCapture.drafts, []);
  await popup.close();
  await popupSource.close();

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
      collectionMarkdown: await read(collections, 'Worker collection.md'), names: names.sort(),
      pending: Object.keys(stored).filter(key => key.startsWith('minePendingSaveOperation:')) };
  });
  assert.equal(finalCapture.markdown, uiCapture.markdown);
  assert.equal(finalCapture.collectionMarkdown, uiCapture.collectionMarkdown);
  assert.deepEqual(finalCapture.names, ['Worker UI article.md', 'Worker image.md']);
  assert.deepEqual(finalCapture.pending, []);
  await checkOverlayAcrossPages(worker);
  await checkHeaderDragBySpaceName(worker);
  await checkCollectionsArePages(worker);
  Object.assign(report, { ok: true, scope: 'chromium-extension-worker-wasm',
    fixtures: fixtures.length, headless: true, temporaryProfile: true,
    persistedHandleBlobReceipt: true, browserRestarts: 3, popupSaveToFile: true,
    popupSelectedCollectionToFile: true, noClipStorageBeforeSave: true, journalClearedAfterSave: true,
    savedFileStableAfterBrowserReopen: true,
    standaloneSetupTransport: true, nativeStatusTransport: true, serviceWorkerRestarts: 2,
    overlayLeavesPageWorking: true, overlayClipAcrossNewDocument: true, screenshotOfShownPageForOriginalCard: true,
    overlayMovedResizedKeptAndFitted: true, overlayResizedByTopLeftCorner: true,
    overlayDraggedBySpaceName: true, spaceMenuOpensOnClickNotDrag: true, openClipClearedAfterSave: true,
    collectionsListedAsPagesOnly: true, saveIntoCollectionWithoutPageWritesNothing: true,
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
