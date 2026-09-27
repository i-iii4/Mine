import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Render the actual scanner output through Mine's production Grid. No synthetic
// card data or native IPC success is substituted here. This is browser rendering,
// not a claim that the installed Tauri window was exercised.
export async function renderCapturedCard({ snapshotPath, outputDirectory, slug, expectedText }) {
  const payload = JSON.parse(await readFile(snapshotPath, 'utf8'));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const allowedAssets = await realpath(outputDirectory);
  const server = await createServer({
    root,
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, open: false },
    logLevel: 'error',
  });
  let browser;
  try {
    await server.listen();
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== 'string');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/__cold-space-snapshot', route => route.fulfill({ json: payload }));
    await page.route('**/__cold-space-asset?*', async route => {
      const requested = new URL(route.request().url()).searchParams.get('path');
      const path = requested ? await realpath(requested).catch(() => null) : null;
      if (!path || !path.startsWith(`${allowedAssets}${sep}`)) {
        await route.fulfill({ status: 403 });
        return;
      }
      await route.fulfill({ path });
    });
    await page.goto(`http://127.0.0.1:${address.port}/__cold-space-audit`);
    const stages = [];
    for (const stage of ['first', 'settled']) {
      if (stage === 'settled') {
        await page.evaluate(() => window.__MINE_COLD_SPACE_AUDIT__.settle());
      }
      await page.locator(`[data-cold-space-stage="${stage}"]`).waitFor();
      // Grid exposes the source slug on the item itself across card variants.
      const sourceCard = page.locator(`[data-feed-grid-item-live="true"][data-feed-grid-item-slug=${JSON.stringify(slug)}]`);
      await sourceCard.waitFor({ state: 'visible' });
      assert.equal(await sourceCard.count(), 1);
      await page.waitForFunction(({ slug, expectedText }) => {
        const item = Array.from(document.querySelectorAll('[data-feed-grid-item-live="true"]'))
          .find(node => node.getAttribute('data-feed-grid-item-slug') === slug);
        return item?.textContent?.includes(expectedText);
      }, { slug, expectedText });
      stages.push({ stage, slug, text: await sourceCard.innerText() });
      await sourceCard.screenshot({ path: join(outputDirectory, `mine-card-${stage}.png`) });
    }
    assert.deepEqual(errors, [], 'Mine Grid renderer must not crash');
    return { productionGridRendered: true, stages, errors };
  } finally {
    await browser?.close();
    await server.close();
  }
}
