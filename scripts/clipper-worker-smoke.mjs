// Real packaged classic worker + CSP + WASM + IndexedDB persistence. OPFS lives
// only in a disposable profile: this does not test OS folders/permissions or Dia.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { extensionBuildVersion, stampExtensionBuild } from './clipper-extension-payload.mjs';

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
// Each build names its own worker wrapper (SPEC_CLIPPER.md, К4).
const workerUrl = `chrome-extension://${extensionId}/${manifest.background.service_worker}`;

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
  assert.equal(worker.url(), workerUrl);
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

async function restartWorker(page, browser = context) {
  const devtools = await browser.newCDPSession(page);
  try {
    const { targetInfos } = await devtools.send('Target.getTargets');
    const target = targetInfos.find((candidate) => candidate.type === 'service_worker'
      && candidate.url === workerUrl);
    assert.ok(target, 'packaged service-worker target is unavailable');
    assert.equal((await devtools.send('Target.closeTarget', { targetId: target.targetId })).success, true);
    await waitForTargetToClose(devtools, target.targetId);
    const result = await sendBackgroundMessage(page, { action: 'standaloneStatus' });
    assert.equal(result.transportError, null);
    assert.equal(typeof result.response?.configured, 'boolean');
    const restarted = await devtools.send('Target.getTargets');
    assert.ok(restarted.targetInfos.some((candidate) => candidate.type === 'service_worker'
      && candidate.url === workerUrl), 'standaloneStatus did not wake the worker');
    return browser.serviceWorkers().find((candidate) => candidate.url() === workerUrl)
      ?? await browser.waitForEvent('serviceworker', { timeout: 15_000 });
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

// Р9 for any clip, the types in any order (SPEC_CLIPPER.md, «Доработки после
// живого просмотра», 12.10.2026). A right click on a link offers only Save
// link of Mine; that clip opens as Link, and Screenshot chosen after Content
// stays chosen and takes the page shown for the clip of the link.
async function checkScreenshotForAnyClip(worker) {
  const { server, origin } = await startSite();
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${origin}/a`);
    // The browser takes two captures a second; the previous check's last one
    // must not count against this one.
    await page.waitForTimeout(1_100);
    await worker.evaluate(async ({ url, link }) => {
      const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === url);
      if (!tab) throw new Error('No tab for the local page');
      await chrome.tabs.update(tab.id, { active: true });
      await handleContextMenuClick({ menuItemId: 'save-link', linkUrl: link, pageUrl: url }, tab);
    }, { url: `${origin}/a`, link: `${origin}/b` });
    const type = (name) => page.getByRole('tab', { name, exact: true });
    await type('Link').waitFor({ timeout: 15_000 });
    assert.equal(await type('Link').getAttribute('aria-selected'), 'true');

    // Content takes the keyboard to its segment; Screenshot then hides the
    // overlay for the capture and gives the keyboard back.
    await type('Content').click();
    assert.equal(await type('Content').getAttribute('aria-selected'), 'true');
    await type('Screenshot').click();
    const preview = page.locator('[data-clipper-preview] img');
    await preview.waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(await type('Screenshot').getAttribute('aria-selected'), 'true', 'Screenshot chosen after Content went back to Content');
    const error = page.locator('[data-clipper-capture-error]');
    assert.equal(await error.count(), 0, `the screenshot of a Save link clip was refused: ${await error.allTextContents()}`);

    // The frame is of page A, the page shown; the clip stays the one of link B.
    const colour = await preview.evaluate(async (image) => {
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const draw = canvas.getContext('2d');
      draw.drawImage(image, 0, 0);
      const [red, green, blue] = draw.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
      return { red, green, blue };
    });
    assert.ok(colour.red > 200 && colour.blue < 60, `the screenshot is not of page A: ${JSON.stringify(colour)}`);
    const kept = await worker.evaluate(async () => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const session = await chrome.storage.session.get(null);
        const clip = Object.entries(session).find(([key, value]) => key.startsWith('mineOpenClip:') && value.currentType === 'screenshot')?.[1];
        if (clip?.screenshot) return { linkTarget: clip.linkTarget, url: clip.metadata.url, framed: clip.screenshot.dataUrl.startsWith('data:image/') };
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return null;
    });
    assert.deepEqual(kept, { linkTarget: `${origin}/b`, url: `${origin}/b`, framed: true });

    await page.locator('[data-mine-clipper-overlay]').getByRole('button', { name: 'Close', exact: true }).first().click();
    await page.locator('[data-mine-clipper-panel]').waitFor({ state: 'detached', timeout: 5_000 });
  } finally {
    await page.close();
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

// A helper that answers every request the way the real one answers
// get_status about the extension: the build of the installed copy, read from
// its identity file on disk at each request (native_host.rs).
const UPDATE_HELPER = `import { readFileSync } from 'node:fs';
const identityPath = process.argv[2];
let input = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4 && input.length >= 4 + input.readUInt32LE(0)) {
    const length = input.readUInt32LE(0);
    const request = JSON.parse(input.subarray(4, 4 + length).toString('utf8'));
    input = input.subarray(4 + length);
    const installed = JSON.parse(readFileSync(identityPath, 'utf8')).buildId;
    const reply = Buffer.from(JSON.stringify({ _messageId: request._messageId, ok: true, connected: true,
      features: [], extension_build_id: installed }));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(reply.length);
    process.stdout.write(Buffer.concat([header, reply]));
  }
});
`;

// A helper that answers get_status as the real one does about this build and
// refuses list_channels the way the real one does when it cannot read the
// collections (native_host.rs, handle_list_channels).
const TRANSPORT_HELPER = `import { readFileSync } from 'node:fs';
const identityPath = process.argv[2];
let input = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4 && input.length >= 4 + input.readUInt32LE(0)) {
    const length = input.readUInt32LE(0);
    const request = JSON.parse(input.subarray(4, 4 + length).toString('utf8'));
    input = input.subarray(4 + length);
    const answer = request.action === 'list_channels'
      ? { ok: false, code: 'collections_unavailable', error: 'Mine could not read the collections of this space.' }
      : { ok: true, connected: true, features: [], extension_build_id: JSON.parse(readFileSync(identityPath, 'utf8')).buildId };
    const reply = Buffer.from(JSON.stringify({ _messageId: request._messageId, ...answer }));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(reply.length);
    process.stdout.write(Buffer.concat([header, reply]));
  }
});
`;

// The background passes the replies of a registered helper on as they are: a
// success the check expects is a success, or the check fails with the code
// and reason of the refusal; a refusal keeps the helper's code (Е7.9). Runs in
// its own profile with a disposable helper, never one a person registered.
async function checkNativeHelperReplies() {
  const sandbox = mkdtempSync(join(tmpdir(), 'mine-clipper-native-replies-'));
  const profile = join(sandbox, 'profile');
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  let browser;
  try {
    const hostName = readFileSync(join(extension, 'background.js'), 'utf8').match(/const HOST_NAME = "([^"]+)";/)?.[1];
    assert.ok(hostName, 'packaged native host name is unavailable');
    const helper = join(sandbox, 'helper.mjs');
    writeFileSync(helper, TRANSPORT_HELPER);
    const launcher = join(sandbox, 'helper');
    writeFileSync(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(helper)} ${quote(join(extension, 'dist/runtime-identity.json'))} "$@"\n`, { mode: 0o700 });
    mkdirSync(join(profile, 'NativeMessagingHosts'), { recursive: true });
    writeFileSync(join(profile, `NativeMessagingHosts/${hostName}.json`), JSON.stringify({
      name: hostName, description: 'Disposable Mine transport acceptance', path: launcher,
      type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`],
    }));
    browser = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker', { timeout: 15_000 });
    const page = await browser.newPage();
    await page.route('**/dist/assets/*', (route) => route.abort());
    await page.goto(`chrome-extension://${extensionId}/dist/index.html`);
    const status = await checkedBackgroundMessage(page, { action: 'nativeMessage', payload: { action: 'get_status' } });
    assert.equal(status.extension_build_id, report.runtimeIdentity.buildId, JSON.stringify(status));
    const refused = await sendBackgroundMessage(page, { action: 'nativeMessage', payload: { action: 'list_channels' } });
    assert.equal(refused.transportError, null);
    assert.equal(refused.response?.ok, false, `the helper's refusal arrived as ${JSON.stringify(refused.response)}`);
    assert.equal(refused.response.code, 'collections_unavailable', JSON.stringify(refused.response));
  } finally {
    await browser?.close();
    // Allocated above for this check only, never a user profile or helper.
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// Pages on disk and a record past 10 MB (SPEC_DEEP_AUDIT.md, Е3.8, Е3.12,
// Е3.19). The overlay on an HTML page on disk has its stylesheet: the page
// may read it. An SVG page cannot hold the overlay, and the clipper opens as
// its window instead of not at all. Local storage keeps a record past its
// 10 MB quota: the journal of a save keeps the screenshot it sends.
async function checkPagesOnDiskAndLargeRecords(worker) {
  const pages = mkdtempSync(join(tmpdir(), 'mine-clipper-pages-on-disk-'));
  try {
    writeFileSync(join(pages, 'page.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Page on disk</title></head><body><p>A page on disk.</p></body></html>');
    writeFileSync(join(pages, 'drawing.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="100" height="100" fill="red"/></svg>');
    const open = (name) => worker.evaluate(async (fileName) => {
      const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url?.startsWith('file://') && candidate.url.endsWith(`/${fileName}`));
      if (!tab) throw new Error(`No tab for ${fileName}`);
      await chrome.tabs.update(tab.id, { active: true });
      return openClipperUi(tab);
    }, name);

    const page = await context.newPage();
    await page.goto(`file://${join(pages, 'page.html')}`);
    assert.equal(await open('page.html'), 'overlay');
    await page.locator('[data-mine-clipper-panel]').waitFor({ state: 'visible', timeout: 15_000 });
    const css = await page.evaluate(() => document.querySelector('[data-mine-clipper-overlay]')?.shadowRoot?.querySelector('style')?.textContent ?? '');
    assert.ok(css.includes('--foreground'), 'the overlay on a page on disk opened without its stylesheet');
    await page.locator('[data-mine-clipper-overlay]').getByRole('button', { name: 'Close', exact: true }).first().click();
    await page.close();

    const drawing = await context.newPage();
    await drawing.goto(`file://${join(pages, 'drawing.svg')}`);
    const clipperWindow = context.waitForEvent('page', { timeout: 15_000 });
    assert.equal(await open('drawing.svg'), 'window');
    const popup = await clipperWindow;
    await popup.waitForURL(/\/dist\/index\.html/, { timeout: 15_000 });
    await popup.close();
    await drawing.close();

    const large = await worker.evaluate(async () => {
      const key = 'mineSmokeLargeRecord';
      try {
        await chrome.storage.local.set({ [key]: 'x'.repeat(11 * 1024 * 1024) });
        return { ok: true, bytes: await chrome.storage.local.getBytesInUse(key) };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      } finally {
        await chrome.storage.local.remove(key);
      }
    });
    assert.equal(large.ok, true, `local storage refused a record past 10 MB: ${large.error}`);
    assert.ok(large.bytes > 10 * 1024 * 1024);
  } finally {
    rmSync(pages, { recursive: true, force: true });
  }
}

// A feed of X with two posts, in the markup of a list feed as measured on
// 11.10.2026 (extension/lib/xFeed.fixtures.ts), served in place of x.com: the
// page's content script puts the Mine button in each post's header
// (SPEC_CLIPPER.md, «Кнопка Mine в ленте X»). Syndication answers the post a
// button reads, since no feed of the page delivered it (rule 6). It answers
// the way the real service does (checked on x.com and with curl 13.10.2026):
// only to the origin of X's embed widget, so the browser refuses its answer
// to a page of x.com, a content script's request included, on CORS.
const X_POSTS = [{ id: '2001', text: 'Smoke post 2001' }, { id: '2002', text: 'Smoke post 2002' }];
const SYNDICATION_ALLOWED_ORIGIN = 'https://platform.twitter.com';
const X_POST_UNAVAILABLE = "Mine couldn't read this post here. Open the post and save it from its page.";
const X_HEADER_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" class="r-4qtqp9"><g><path d="M3 12c0-1.1.9-2 2-2"></path></g></svg>';

function xCard({ id, text }) {
  const status = `/smokeposter/status/${id}`;
  const name = '<div data-testid="User-Name"><div><a href="/smokeposter" role="link"><span>Smoke Poster</span></a></div>'
    + `<div><a href="/smokeposter" role="link"><span>@smokeposter</span></a><a href="${status}" role="link"><time datetime="2026-10-13T10:00:00.000Z">1h</time></a></div></div>`;
  const grok = '<div class="css-175oi2r r-grok-box"><button aria-label="Grok actions" role="button" class="css-175oi2r r-grok" type="button">'
    + `<div dir="ltr" class="css-146c3p1">${X_HEADER_ICON}</div></button></div>`;
  const caret = '<div class="css-175oi2r r-1awozwy r-6koalj r-18u37iz"><div><div class="css-175oi2r r-18u37iz r-1h0z5md">'
    + '<button aria-label="More" role="button" class="css-175oi2r r-1777fci" data-testid="caret" type="button">'
    + `<div dir="ltr" class="css-146c3p1"><div class="css-175oi2r r-xoduu5"><div class="css-175oi2r r-1niwhzg"></div>${X_HEADER_ICON}</div></div></button></div></div></div>`;
  const header = '<div class="css-175oi2r r-zl2h9q"><div class="css-175oi2r r-k4xj1c r-18u37iz r-1wtj0ep">'
    + `<div class="css-175oi2r r-1d09ksm"><div class="css-175oi2r r-1wbh5a2">${name}</div></div>`
    + `<div class="css-175oi2r r-1kkk96v"><div class="css-175oi2r r-1awozwy r-18u37iz">${grok}${caret}</div></div></div></div>`;
  return `<div data-testid="cellInnerDiv"><div><article role="article" tabindex="0" data-testid="tweet"><div>${header}</div>`
    + `<div data-testid="tweetText"><span>${text}</span></div></article></div></div>`;
}

const X_FEED_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Home / X</title></head>
<body><main>${X_POSTS.map(xCard).join('')}</main></body></html>`;

/// Serve the X feed and the syndication answers inside `browser`: no request
/// leaves the machine.
async function serveXFeed(browser) {
  await browser.route('https://x.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: X_FEED_PAGE }));
  await browser.route('https://cdn.syndication.twimg.com/**', (route) => {
    const headers = { 'access-control-allow-origin': SYNDICATION_ALLOWED_ORIGIN };
    const post = X_POSTS.find(({ id }) => new URL(route.request().url()).searchParams.get('id') === id);
    if (!post) return route.fulfill({ status: 404, headers, body: '' });
    return route.fulfill({ status: 200, contentType: 'application/json', headers,
      body: JSON.stringify({ __typename: 'Tweet', id_str: post.id, text: post.text,
        user: { screen_name: 'smokeposter', name: 'Smoke Poster' }, mediaDetails: [] }) });
  });
}

/// The clip an open overlay keeps for `postUrl`, as background holds it
/// (Р7), or `null` when none comes in time.
function keptClipOf(worker, postUrl) {
  return worker.evaluate(async (url) => {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const session = await chrome.storage.session.get(null);
      const kept = Object.entries(session).find(([key, value]) => key.startsWith('mineOpenClip:') && value?.metadata?.url === url)?.[1];
      if (kept) return kept;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }, postUrl);
}

// The Mine button of an X post no feed of its page delivered (SPEC_CLIPPER.md,
// «Кнопка Mine в ленте X», rule 6, 13.10.2026). The page world's cache is
// there and knows no post, so the post comes from the syndication service,
// which refuses the page of x.com the way the real one does. Background asks
// it by the extension's host permissions, and the clipper opens with the
// post's text, not with the reason it could not be read.
async function checkXPostWithoutPageCache(worker) {
  await serveXFeed(context);
  const feed = await context.newPage();
  try {
    await worker.evaluate(async () => {
      const status = await globalThis.MineStandaloneVault.getStandaloneStatus();
      await chrome.storage.local.set({ mineSaveDestination: { executor: 'browser', bindingId: status.bindingId } });
    });
    await feed.goto('https://x.com/home');
    const buttons = feed.locator('[data-mine-x-post]');
    await pollUntil(async () => (await buttons.count()) === X_POSTS.length || undefined, 'the feed did not get its Mine buttons');
    const [post] = X_POSTS;
    assert.equal(await feed.evaluate((id) => globalThis.MineXThreadPage.post(id), post.id), null,
      'a feed of the page delivered the post');
    assert.equal(await feed.evaluate((id) => fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=0`)
      .then(() => 'answered', (error) => error.message), post.id), 'Failed to fetch', 'the service answered the page of x.com');

    await feed.evaluate(() => document.querySelector('[data-mine-x-post] button').click());
    const panel = feed.locator('[data-mine-clipper-panel]');
    await panel.waitFor({ state: 'visible', timeout: 15_000 });
    let shown = '';
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !shown.includes(post.text) && !shown.includes(X_POST_UNAVAILABLE)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      shown = await panel.textContent();
    }
    assert.ok(shown.includes(post.text) && !shown.includes(X_POST_UNAVAILABLE),
      `the Mine button did not open the clipper with the post: ${shown}`);
    const clip = await keptClipOf(worker, `https://x.com/smokeposter/status/${post.id}`);
    assert.ok(clip && JSON.stringify(clip).includes(post.text), `the clip lacks the post: ${JSON.stringify(clip).slice(0, 2000)}`);
    await panel.getByRole('button', { name: 'Close', exact: true }).first().click({ timeout: 5_000 });
    await panel.waitFor({ state: 'detached', timeout: 5_000 });
  } finally {
    await feed.close();
    await worker.evaluate(async () => chrome.storage.local.remove(['mineSaveDestination']));
    await context.unroute('https://x.com/**');
    await context.unroute('https://cdn.syndication.twimg.com/**');
  }
}

// A post of X's feed, delivered by the feed response the page reads after the
// extension's reload; the syndication service has no answer for it.
const X_FEED_POST = { id: '2003', text: 'Smoke feed post 2003' };
const X_FEED_RESPONSE = { data: { home: { home_timeline_urt: { instructions: [{ type: 'TimelineAddEntries', entries: [{
  entryId: `tweet-${X_FEED_POST.id}`,
  content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTweet', tweet_results: { result: {
    __typename: 'Tweet', rest_id: X_FEED_POST.id,
    core: { user_results: { result: { rest_id: '77', core: { screen_name: 'smokeposter', name: 'Smoke Poster' } } } },
    legacy: { id_str: X_FEED_POST.id, full_text: X_FEED_POST.text, entities: {} },
  } } } },
}] }] } } } };

// A tab of X open while the extension did not run, the way a tab open before
// its install is: no script of the extension is in it, its page world has no
// post cache (13.10.2026). The reload of the extension puts the content
// scripts of the manifest into it, those of the page world among them
// (SPEC_CLIPPER.md, К4, «Открытые страницы после перезагрузки»): the feeds
// the page reads from then on fill the cache, and the Mine button reads its
// post from there. Runs on a copy in its own profile.
async function checkXPageWorldAfterReload() {
  const sandbox = mkdtempSync(join(tmpdir(), 'mine-clipper-x-reload-'));
  const installed = join(sandbox, 'extension');
  const profile = join(sandbox, 'profile');
  let browser;
  try {
    cpSync(extension, installed, { recursive: true });
    browser = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${installed}`, `--load-extension=${installed}`],
    });
    let worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker', { timeout: 15_000 });
    await enableDeveloperMode(browser);
    const settings = await browser.newPage();
    await settings.goto('chrome://extensions');
    const setEnabled = (enabled) => settings.evaluate(async ([id, on]) => {
      await chrome.management.setEnabled(id, on);
      return (await chrome.management.get(id)).enabled;
    }, [extensionId, enabled]);
    assert.equal(await setEnabled(false), false);

    await serveXFeed(browser);
    await browser.route('https://x.com/i/api/graphql/**', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(X_FEED_RESPONSE) }));
    const feed = await browser.newPage();
    await feed.goto('https://x.com/home');
    const pageState = () => feed.evaluate(() => ({ cache: typeof globalThis.MineXThreadPage?.post,
      buttons: document.querySelectorAll('[data-mine-x-post]').length }));

    const started = browser.waitForEvent('serviceworker', { timeout: 15_000, predicate: (candidate) => candidate.url() === workerUrl });
    started.catch(() => undefined);
    assert.equal(await setEnabled(true), true);
    worker = await started;
    // Turning the extension on puts nothing into the open tab.
    assert.deepEqual(await pageState(), { cache: 'undefined', buttons: 0 });

    const reloaded = browser.waitForEvent('serviceworker', { timeout: 15_000, predicate: (candidate) => candidate.url() === workerUrl });
    reloaded.catch(() => undefined);
    await worker.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 50); });
    worker = await reloaded;
    let state;
    const deadline = Date.now() + 10_000;
    do {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = await pageState();
    } while (Date.now() < deadline && !(state.cache === 'function' && state.buttons === X_POSTS.length));
    assert.deepEqual(state, { cache: 'function', buttons: X_POSTS.length },
      'the tab of X open before the reload did not get the scripts of the page world and of the content script');

    // X reads the next part of its feed and shows its post.
    await feed.evaluate(() => fetch('/i/api/graphql/smoke/HomeTimeline').then((response) => response.json()));
    await feed.evaluate((html) => document.querySelector('main').insertAdjacentHTML('beforeend', html), xCard(X_FEED_POST));
    await pollUntil(async () => (await pageState()).buttons === X_POSTS.length + 1 || undefined, 'the post of the feed got no Mine button');
    assert.equal((await feed.evaluate((id) => globalThis.MineXThreadPage.post(id), X_FEED_POST.id))?.text, X_FEED_POST.text,
      'the cache of the page world did not read the feed');
    await feed.evaluate((id) => document.querySelector(`article:has(a[href$="/status/${id}"]) [data-mine-x-post] button`).click(), X_FEED_POST.id);
    await feed.locator('[data-mine-clipper-panel]').waitFor({ state: 'visible', timeout: 15_000 });
    // No space is chosen in this profile, so the panel shows no preview; the
    // clip the overlay hands to the worker shows what it opened with (Р7).
    const clip = await keptClipOf(worker, `https://x.com/smokeposter/status/${X_FEED_POST.id}`);
    const kept = JSON.stringify(clip);
    assert.ok(clip && kept.includes(X_FEED_POST.text) && !kept.includes(X_POST_UNAVAILABLE),
      `the Mine button did not open the clipper with the post of the feed: ${kept?.slice(0, 2000)}`);
  } finally {
    await browser?.close();
    // Allocated above for this check only, never a user profile or extension.
    rmSync(sandbox, { recursive: true, force: true });
  }
}

const CORE_COMMAND = { op: 'layout', layout: { cards: '', media: '', collections: '' } };

/// One command through the worker's save core, its refusal as data.
function coreReply(worker) {
  return worker.evaluate(async (command) => {
    try {
      return { ok: true, value: await globalThis.MineCore.call(command) };
    } catch (error) {
      return { ok: false, code: error.code ?? null, message: String(error.message ?? error) };
    }
  }, CORE_COMMAND);
}

async function pollUntil(read, label) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out: ${label}`);
}

// A person's browser loads the copy through Load unpacked, which needs
// developer mode; without it the browser does not load an unpacked extension
// that reloads itself again, it disables it (К4).
async function enableDeveloperMode(browser) {
  const settings = await browser.newPage();
  await settings.goto('chrome://extensions');
  assert.equal(await settings.evaluate(async () => {
    await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true });
    return (await chrome.developerPrivate.getProfileConfiguration()).inDeveloperMode;
  }), true);
  await settings.close();
}

// Turn the copy at `staged` into the next build the way the extension build
// makes one: its own build identity, background and overlay, then its own
// version and worker wrapper (scripts/clipper-extension-payload.mjs). The
// background and the overlay mark the world they run in.
function makeNextBuild(staged) {
  const next = { buildId: createHash('sha256').update(`${report.runtimeIdentity.buildId}:next`).digest('hex'), commit: 'next-commit' };
  writeFileSync(join(staged, 'dist/runtime-identity.json'), `${JSON.stringify(next)}\n`);
  writeFileSync(join(staged, 'dist/build-identity.js'), `globalThis.MineBuildIdentity = Object.freeze(${JSON.stringify(next)});\n`);
  writeFileSync(join(staged, 'background.js'),
    `${readFileSync(join(staged, 'background.js'), 'utf8')}\nglobalThis.MineNextBackground = true;\n`);
  writeFileSync(join(staged, 'dist/overlay.js'),
    `${readFileSync(join(staged, 'dist/overlay.js'), 'utf8')}\n;globalThis.__mineSmokeOverlayBuild = ${JSON.stringify(next.buildId)};\n`);
  const version = extensionBuildVersion();
  const worker = stampExtensionBuild(staged, version);
  return { ...next, version, workerUrl: `chrome-extension://${extensionId}/${worker}` };
}

// Chromium location of an extension added with Load unpacked.
const UNPACKED_LOCATION = 4;

function registeredLocation(profile) {
  for (const name of ['Secure Preferences', 'Preferences']) {
    const path = join(profile, 'Default', name);
    if (!existsSync(path)) continue;
    const location = JSON.parse(readFileSync(path, 'utf8'))?.extensions?.settings?.[extensionId]?.location;
    if (location !== undefined) return location;
  }
  return null;
}

// A browser restart runs the build on disk (SPEC_CLIPPER.md, К4, 13.10.2026).
// Chromium keeps the worker registered across restarts. It registers the
// worker again only when the manifest names another version than the one
// registered, and a new registration at the same script address keeps the old
// script. Each build therefore has its own version and its own worker file.
// The copy is registered as a person's browser holds it, Load unpacked (one
// reload turns the command-line load into that), and the browser restarts
// without any extension switch after the next build replaced the files.
async function checkBrowserRestartRunsBuildOnDisk() {
  const sandbox = mkdtempSync(join(tmpdir(), 'mine-clipper-restart-'));
  const installed = join(sandbox, 'extension');
  const profile = join(sandbox, 'profile');
  let browser;
  try {
    cpSync(extension, installed, { recursive: true });
    browser = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${installed}`, `--load-extension=${installed}`],
    });
    let worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker', { timeout: 15_000 });
    await enableDeveloperMode(browser);
    const reloaded = browser.waitForEvent('serviceworker', { timeout: 15_000 });
    reloaded.catch(() => undefined);
    await worker.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 50); });
    worker = await reloaded;
    assert.equal(worker.url(), workerUrl);
    assert.equal(await worker.evaluate(() => globalThis.MineBuildIdentity?.buildId), report.runtimeIdentity.buildId);
    await browser.close();
    browser = undefined;
    assert.equal(registeredLocation(profile), UNPACKED_LOCATION, 'the copy is not registered as Load unpacked registers it');

    // The next build replaces the copy while the browser is closed, the way
    // an install does: a new directory renamed into the same path.
    const staged = join(sandbox, 'next');
    cpSync(installed, staged, { recursive: true });
    const next = makeNextBuild(staged);
    renameSync(installed, join(sandbox, 'previous'));
    renameSync(staged, installed);

    browser = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    });
    worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker', { timeout: 15_000 });
    const running = await worker.evaluate(() => ({
      build: globalThis.MineBuildIdentity?.buildId ?? null,
      nextBackground: globalThis.MineNextBackground === true,
      version: chrome.runtime.getManifest().version,
    }));
    assert.deepEqual({ url: worker.url(), ...running },
      { url: next.workerUrl, build: next.buildId, nextBackground: true, version: next.version },
      'the restarted browser runs the background of another build than the one on disk');
  } finally {
    await browser?.close();
    // Allocated above for this check only, never a user profile or extension.
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// An update replaces the extension files on disk while the browser keeps
// running the worker it loaded, across worker restarts too (SPEC_CLIPPER.md,
// К4, 12.10.2026). The worker compares the build written into its own code
// with the build the helper reports and reloads itself into the new one once
// no clipper is open. Nothing it reads from disk meanwhile is of the new
// build: its save core keeps its own binary, and a clipper opened then is
// opened by the worker of the new build after the reload. The pages open
// before get the content script of the new build, whose buttons replace the
// old ones (13.10.2026). Runs on a copy in its own profile: the checked
// extension, an installed Mine.app among them, is never changed.
async function checkUpdateReloadsWorker() {
  const sandbox = mkdtempSync(join(tmpdir(), 'mine-clipper-update-'));
  const installed = join(sandbox, 'extension');
  const profile = join(sandbox, 'profile');
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  let browser;
  try {
    cpSync(extension, installed, { recursive: true });
    const hostName = readFileSync(join(installed, 'background.js'), 'utf8').match(/const HOST_NAME = "([^"]+)";/)?.[1];
    assert.ok(hostName, 'packaged native host name is unavailable');
    const helper = join(sandbox, 'helper.mjs');
    writeFileSync(helper, UPDATE_HELPER);
    const launcher = join(sandbox, 'helper');
    writeFileSync(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(helper)} ${quote(join(installed, 'dist/runtime-identity.json'))} "$@"\n`, { mode: 0o700 });
    mkdirSync(join(profile, 'NativeMessagingHosts'), { recursive: true });
    writeFileSync(join(profile, `NativeMessagingHosts/${hostName}.json`), JSON.stringify({
      name: hostName, description: 'Disposable Mine update acceptance', path: launcher,
      type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`],
    }));
    browser = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${installed}`, `--load-extension=${installed}`],
    });
    let worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker', { timeout: 15_000 });
    await enableDeveloperMode(browser);
    const oldBuild = report.runtimeIdentity.buildId;
    // The shipped worker carries the build its identity file names.
    assert.equal(await worker.evaluate(() => globalThis.MineBuildIdentity?.buildId), oldBuild);
    const restartWithTransport = async () => {
      const transport = await browser.newPage();
      await transport.route('**/dist/assets/*', (route) => route.abort());
      await transport.goto(`chrome-extension://${extensionId}/dist/index.html`);
      try {
        return await restartWorker(transport, browser);
      } finally {
        await transport.close();
      }
    };

    // An X feed open before the update, with the Mine button of the build
    // that loaded it on each post.
    await serveXFeed(browser);
    const feed = await browser.newPage();
    await feed.goto('https://x.com/home');
    const xButtons = feed.locator('[data-mine-x-post]');
    await pollUntil(async () => (await xButtons.count()) === X_POSTS.length || undefined, 'the feed did not get its Mine buttons');
    await feed.evaluate(() => {
      for (const box of document.querySelectorAll('[data-mine-x-post]')) box.setAttribute('data-smoke-before-update', '');
    });
    // The save core of the running build is read once while the disk holds it.
    assert.deepEqual(await coreReply(worker), { ok: true, value: CORE_COMMAND.layout });

    // Another build replaces the copy the way an install does: a new
    // directory renamed into the same path. Its save core binary is not one,
    // so any read of it fails.
    const staged = join(sandbox, 'next');
    const previous = join(sandbox, 'previous');
    const binary = 'generated/save-core/mine_core_bg.wasm';
    cpSync(installed, staged, { recursive: true });
    const next = makeNextBuild(staged);
    writeFileSync(join(staged, binary), 'not the save core of any build');
    renameSync(installed, previous);
    renameSync(staged, installed);

    // A restarted worker still runs the code the browser loaded, while a file
    // read already answers the new copy: the cause of the 12.10.2026 failure.
    worker = await restartWithTransport();
    const restarted = await worker.evaluate(async () => ({
      running: globalThis.MineBuildIdentity?.buildId,
      nextBackground: globalThis.MineNextBackground === true,
      onDisk: (await (await fetch(chrome.runtime.getURL('dist/runtime-identity.json'))).json()).buildId,
    }));
    assert.deepEqual(restarted, { running: oldBuild, nextBackground: false, onDisk: next.buildId });

    // The glue of the running build gets the binary of its build, kept when
    // it was read, never the one on disk now (13.10.2026).
    assert.deepEqual(await coreReply(worker), { ok: true, value: CORE_COMMAND.layout },
      'the running save core read the binary of another build');
    // Without the kept binary the core refuses the one on disk, and the
    // reload into its build becomes pending.
    await worker.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('mine-save-core');
      request.onsuccess = resolve;
      request.onblocked = resolve;
      request.onerror = () => reject(request.error);
    }));
    worker = await restartWithTransport();
    const refused = await coreReply(worker);
    assert.equal(refused.code, 'extension_updated', JSON.stringify(refused));
    assert.equal((await worker.evaluate(() => chrome.storage.session.get('mineReloadPending'))).mineReloadPending, next.buildId);
    // The next build gets a working binary for what follows.
    cpSync(join(previous, binary), join(installed, binary));

    // The helper reports the installed build: the update is pending.
    const status = await worker.evaluate(() => sendNativeMessage({ action: 'get_status' }));
    assert.equal(status.extension_build_id, next.buildId, JSON.stringify(status));
    const pending = await pollUntil(async () => (await worker.evaluate(() => chrome.storage.session.get('mineReloadPending'))).mineReloadPending,
      'the old worker did not see the installed build');
    assert.equal(pending, next.buildId);

    // The clipper opened now would read the overlay of the next build: the
    // worker reloads into it first, and the worker of that build, under its
    // own wrapper, opens it.
    const reloaded = browser.waitForEvent('serviceworker', { timeout: 15_000, predicate: (candidate) => candidate.url() === next.workerUrl });
    // A failure below closes the browser under this wait; it reports nothing.
    reloaded.catch(() => undefined);
    const opening = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://x.com/*' });
      return openClipperUi(tab);
    });
    assert.equal(opening, 'deferred', 'the running worker opened the overlay of another build');
    worker = await reloaded;
    const after = await worker.evaluate(async () => ({
      running: globalThis.MineBuildIdentity?.buildId,
      nextBackground: globalThis.MineNextBackground === true,
      reloadedFor: (await chrome.storage.local.get('mineReloadedFor')).mineReloadedFor,
    }));
    assert.deepEqual(after, { running: next.buildId, nextBackground: true, reloadedFor: next.buildId });
    const panel = feed.locator('[data-mine-clipper-panel]');
    await panel.waitFor({ state: 'visible', timeout: 15_000 });
    const pageWorld = () => worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://x.com/*' });
      const [answer] = await chrome.scripting.executeScript({ target: { tabId: tab.id },
        func: () => ({ overlayBuild: globalThis.__mineSmokeOverlayBuild ?? null, contentScript: typeof globalThis.__mineClipper }) });
      const metadata = await chrome.tabs.sendMessage(tab.id, { action: 'extractMetadata' }).catch((error) => ({ error: String(error) }));
      return { ...answer.result, metadataUrl: metadata?.url ?? metadata?.error ?? null };
    });
    // The overlay of the running build runs beside the content script of the
    // running build, which answers the worker.
    assert.deepEqual(await pageWorld(), { overlayBuild: next.buildId, contentScript: 'object', metadataUrl: 'https://x.com/home' });
    await panel.getByRole('button', { name: 'Close', exact: true }).first().click({ timeout: 5_000 });
    await panel.waitFor({ state: 'detached', timeout: 5_000 });

    // The page's old buttons went with the old content script; the new one
    // put one on each post, and its button opens the clipper with the post.
    assert.equal(await feed.locator('[data-smoke-before-update]').count(), 0, 'the old content script left its buttons');
    assert.deepEqual(await feed.evaluate(() => [...document.querySelectorAll('article[data-testid="tweet"]')]
      .map((article) => article.querySelectorAll('[data-mine-x-post]').length)), X_POSTS.map(() => 1));
    await feed.evaluate(() => document.querySelector('[data-mine-x-post] button').click());
    await panel.waitFor({ state: 'visible', timeout: 15_000 });
    // No space is chosen in this profile, so the panel shows no preview; the
    // clip the overlay hands to the worker shows what it opened with (Р7).
    const postUrl = `https://x.com/smokeposter/status/${X_POSTS[0].id}`;
    const clip = await keptClipOf(worker, postUrl);
    assert.ok(clip, `the Mine button did not open the clipper with ${postUrl}`);
    assert.ok(JSON.stringify(clip).includes(X_POSTS[0].text), `the clip of the Mine button lacks the post: ${JSON.stringify(clip).slice(0, 2000)}`);

    // The new worker runs the installed build: the next status changes nothing.
    const again = await worker.evaluate(() => sendNativeMessage({ action: 'get_status' }));
    assert.equal(again.extension_build_id, next.buildId);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((await worker.evaluate(() => chrome.storage.session.get('mineReloadPending'))).mineReloadPending, undefined);
  } finally {
    await browser?.close();
    // Allocated above for this check only, never a user profile or extension.
    rmSync(sandbox, { recursive: true, force: true });
  }
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
    // An expected refusal is the refusal with its code; anything else must succeed.
    const refusal = fixture.refusal ?? (fixture.expected?.ok === false ? fixture.expected.error.code : null);
    assert.ok(refusal || !(fixture.name.includes('rejected') || fixture.name.startsWith('invalid')), `${fixture.name}: a refusal without its code`);
    if (refusal) {
      assert.equal(result.ok, false, `${fixture.name}: ${JSON.stringify(result)}`);
      assert.equal(result.error?.code, refusal, `${fixture.name}: ${JSON.stringify(result)}`);
    } else assert.equal(result.ok, true, `${fixture.name}: ${JSON.stringify(result)}`);
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

  // This profile registers no helper, so the background answers for it: the
  // one refusal expected here, by its code and reason. Any other answer fails
  // (SPEC_DEEP_AUDIT.md, Е7.9); checkNativeHelperReplies checks the replies
  // of a registered helper.
  const nativeTransport = await sendBackgroundMessage(transportPage, {
    action: 'nativeMessage', payload: { action: 'get_status' },
  });
  assert.equal(nativeTransport.transportError, null);
  assert.equal(nativeTransport.response?.ok, false, `a helper answered in a profile without one: ${JSON.stringify(nativeTransport.response)}`);
  assert.equal(nativeTransport.response.code, 'native_disconnected', JSON.stringify(nativeTransport.response));
  assert.match(nativeTransport.response.error, /native messaging host not found/i, JSON.stringify(nativeTransport.response));

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
    target.type === 'service_worker' && target.url === workerUrl);
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
  await checkScreenshotForAnyClip(worker);
  await checkHeaderDragBySpaceName(worker);
  await checkCollectionsArePages(worker);
  await checkXPostWithoutPageCache(worker);
  await checkPagesOnDiskAndLargeRecords(worker);
  await context.close();
  context = undefined;
  await checkXPageWorldAfterReload();
  await checkNativeHelperReplies();
  await checkBrowserRestartRunsBuildOnDisk();
  await checkUpdateReloadsWorker();
  Object.assign(report, { ok: true, scope: 'chromium-extension-worker-wasm',
    fixtures: fixtures.length, headless: true, temporaryProfile: true,
    persistedHandleBlobReceipt: true, browserRestarts: 3, popupSaveToFile: true,
    popupSelectedCollectionToFile: true, noClipStorageBeforeSave: true, journalClearedAfterSave: true,
    savedFileStableAfterBrowserReopen: true,
    standaloneSetupTransport: true, nativeRefusalWithoutHelper: true, nativeHelperRepliesPassedOn: true, serviceWorkerRestarts: 2,
    overlayLeavesPageWorking: true, overlayClipAcrossNewDocument: true, screenshotOfShownPageForOriginalCard: true,
    screenshotOfShownPageForSaveLinkClip: true, screenshotStaysChosenAfterContent: true,
    overlayMovedResizedKeptAndFitted: true, overlayResizedByTopLeftCorner: true,
    overlayDraggedBySpaceName: true, spaceMenuOpensOnClickNotDrag: true, openClipClearedAfterSave: true,
    collectionsListedAsPagesOnly: true, saveIntoCollectionWithoutPageWritesNothing: true,
    browserRestartRunsBuildOnDisk: true, restartedWorkerKeepsLoadedBuild: true, updateOnDiskReloadsWorker: true,
    keptSaveCoreOfRunningBuild: true, saveCoreOfAnotherBuildRefused: true, openingReloadsIntoBuildOnDisk: true,
    overlayOfRunningBuild: true, openPagesGetNewContentScript: true, oldContentScriptButtonsRemoved: true,
    xButtonOfNewContentScriptOpensClipper: true, xPostWithoutPageCacheReadThroughBackground: true,
    pageWorldScriptsPutIntoTabOpenBeforeReload: true,
    overlayStyledOnPageOnDisk: true, svgPageOpensClipperWindow: true, localStorageKeepsRecordPast10MB: true,
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
