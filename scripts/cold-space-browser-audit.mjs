#!/usr/bin/env node
import { chromium } from "playwright";
import { PNG } from "pngjs";

const AUDIT_URL = process.env.MINE_COLD_SPACE_AUDIT_URL
  ?? "http://127.0.0.1:1420/__cold-space-audit";
const MIN_VISIBLE_PIXEL_RATIO = 0.003;

function nonBackgroundRatio(buffer) {
  const png = PNG.sync.read(buffer);
  const step = Math.max(1, Math.floor(Math.min(png.width, png.height) / 180));
  const histogram = new Map();
  let sampled = 0;
  for (let y = 0; y < png.height; y += step) {
    for (let x = 0; x < png.width; x += step) {
      const offset = (png.width * y + x) << 2;
      const key = `${png.data[offset] >> 4}:${png.data[offset + 1] >> 4}:${png.data[offset + 2] >> 4}`;
      histogram.set(key, (histogram.get(key) ?? 0) + 1);
      sampled += 1;
    }
  }
  const dominant = Math.max(0, ...histogram.values());
  return sampled === 0 ? 0 : 1 - dominant / sampled;
}

async function waitForLiveViewport(page) {
  await page.waitForFunction(() => {
    const viewport = window.__MINE_FEED_SCROLL_DEBUG__?.viewport;
    return Boolean(
      viewport
      && viewport.layoutViewportPositionCount > 0
      && viewport.liveDomViewportItemCount > 0
      && !viewport.blankViewportRisk,
    );
  });
}

async function inspectViewport(page) {
  return page.locator("[data-grid-scroll]").evaluate((scrollElement) => {
    const scrollRect = scrollElement.getBoundingClientRect();
    const cards = Array.from(
      scrollElement.querySelectorAll('[data-feed-grid-item-live="true"]'),
    ).filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.bottom >= scrollRect.top && rect.top <= scrollRect.bottom;
    });
    const emptySlugs = [];
    for (const card of cards) {
      const text = card.textContent?.trim() ?? "";
      const hasGraphic = card.querySelector("[data-card-graphic-surface]") !== null;
      if (text.length === 0 && !hasGraphic) {
        emptySlugs.push(card.getAttribute("data-feed-grid-item-slug") ?? "unknown");
      }
    }
    return {
      liveCards: cards.length,
      emptySlugs,
      order: cards.map((card) => card.getAttribute("data-feed-grid-item-slug") ?? "unknown"),
      blankViewportRisk: window.__MINE_FEED_SCROLL_DEBUG__?.viewport?.blankViewportRisk ?? null,
    };
  });
}

async function screenshotGrid(page) {
  const grid = page.locator("[data-grid-scroll]");
  return grid.screenshot({ animations: "disabled" });
}

async function main() {
  const response = await fetch(AUDIT_URL, { method: "HEAD" }).catch(() => null);
  if (!response?.ok) {
    throw new Error(`Cold-space audit route is not reachable: ${AUDIT_URL}`);
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
    });
    const browserMessages = [];
    const assetRequests = [];
    page.on("console", (message) => {
      if (message.type() === "warning" || message.type() === "error") {
        browserMessages.push(message.text());
      }
    });
    page.on("request", (request) => {
      if (request.url().includes("/__cold-space-asset")) {
        assetRequests.push(request.url());
      }
    });

    await page.goto(AUDIT_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-cold-space-stage="first"]');
    await waitForLiveViewport(page);
    const firstContract = await page.evaluate(() => window.__MINE_COLD_SPACE_AUDIT__);
    const first = await inspectViewport(page);
    const firstPixels = nonBackgroundRatio(await screenshotGrid(page));
    const link = page.locator('[data-feed-grid-item-slug*="cold-link-"]').first();
    await link.waitFor({ state: "visible" });
    const firstLink = {
      text: (await link.textContent()) ?? "",
      graphicSurfaces: await link.locator("[data-card-graphic-surface]").count(),
    };

    await page.evaluate(() => window.__MINE_COLD_SPACE_AUDIT__?.settle());
    await page.waitForSelector('[data-cold-space-stage="settled"]');
    await waitForLiveViewport(page);
    const settledContract = await page.evaluate(() => window.__MINE_COLD_SPACE_AUDIT__);
    const settled = await inspectViewport(page);
    const settledPixels = nonBackgroundRatio(await screenshotGrid(page));

    await page.locator("[data-grid-scroll]").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await waitForLiveViewport(page);
    const deep = await inspectViewport(page);
    const deepPixels = nonBackgroundRatio(await screenshotGrid(page));

    const failures = [];
    const sourceRoot = settledContract?.sourceRoot ?? firstContract?.sourceRoot ?? "";
    const forbiddenRequests = assetRequests.filter((requestUrl) => {
      const requestedPath = new URL(requestUrl).searchParams.get("path") ?? "";
      return sourceRoot.length > 0 && requestedPath.startsWith(sourceRoot);
    });
    if (!firstContract || !settledContract) {
      failures.push("cold-space IPC contract was not published by the route");
    } else if (settledContract.generation <= firstContract.generation) {
      failures.push(
        `projection generation did not advance: first=${firstContract.generation} settled=${settledContract.generation}`,
      );
    }
    if (first.liveCards === 0 || first.emptySlugs.length > 0 || first.blankViewportRisk) {
      failures.push(`invalid first snapshot: ${JSON.stringify(first)}`);
    }
    if (firstPixels < MIN_VISIBLE_PIXEL_RATIO) {
      failures.push(`first snapshot is visually blank: ratio=${firstPixels.toFixed(4)}`);
    }
    if (firstLink.graphicSurfaces !== 0 || !firstLink.text.includes("Cold metadata link")) {
      failures.push(`metadata-only link fallback is wrong: ${JSON.stringify(firstLink)}`);
    }
    if (settled.liveCards === 0 || settled.emptySlugs.length > 0 || settled.blankViewportRisk) {
      failures.push(`invalid settled snapshot: ${JSON.stringify(settled)}`);
    }
    if (settledPixels < MIN_VISIBLE_PIXEL_RATIO) {
      failures.push(`settled snapshot is visually blank: ratio=${settledPixels.toFixed(4)}`);
    }
    if (deep.liveCards === 0 || deep.emptySlugs.length > 0 || deep.blankViewportRisk) {
      failures.push(`invalid deep cold-space viewport: ${JSON.stringify(deep)}`);
    }
    if (deepPixels < MIN_VISIBLE_PIXEL_RATIO) {
      failures.push(`deep cold-space viewport is visually blank: ratio=${deepPixels.toFixed(4)}`);
    }
    if (forbiddenRequests.length > 0) {
      failures.push(`source assets were requested: ${forbiddenRequests.slice(0, 5).join(" | ")}`);
    }
    if (browserMessages.length > 0) {
      failures.push(`browser warnings/errors: ${browserMessages.slice(0, 5).join(" | ")}`);
    }

    const result = {
      first: { ...first, visiblePixelRatio: Number(firstPixels.toFixed(4)), link: firstLink, generation: firstContract?.generation },
      settled: { ...settled, visiblePixelRatio: Number(settledPixels.toFixed(4)), generation: settledContract?.generation },
      deep: { ...deep, visiblePixelRatio: Number(deepPixels.toFixed(4)) },
      forbiddenRequests,
      browserMessages,
      failures,
    };
    console.log(JSON.stringify(result, null, 2));
    if (failures.length > 0) {
      throw new Error(`Cold-space browser audit failed:\n${failures.join("\n")}`);
    }
    await page.close();
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
