#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { routeEntry, serveProductionPage } from "./audit-production-page.mjs";

const AUDIT_ROUTE = "/__cold-space-audit";
/** A page the caller serves instead, with the snapshot and the previews
 *  behind it (a dev server's `/__cold-space-audit`, vite.config.ts). By
 *  default the audit builds the route for production and serves it itself
 *  with the snapshot `cold-space-audit --browser-output` wrote
 *  (MINE_COLD_SPACE_SNAPSHOT_PATH) and the previews of its derived folder
 *  (MINE_COLD_SPACE_ASSET_ROOT), as `bun run test:browser` passes them:
 *  the page under check is the app's build (AUDIT_PERFORMANCE.md, Пр3). */
const GIVEN_AUDIT_URL = process.env.MINE_COLD_SPACE_AUDIT_URL;
const SNAPSHOT_PATH = process.env.MINE_COLD_SPACE_SNAPSHOT_PATH;
const ASSET_ROOT = process.env.MINE_COLD_SPACE_ASSET_ROOT;
let AUDIT_URL = GIVEN_AUDIT_URL;
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

/** A preview of the derived folder, where the page's asset protocol would
 *  read it (the same address the dev route uses). */
function coldSpaceAssetAddress(path) {
  return path.startsWith("/feed-scroll-audit/") ? path : `/__cold-space-asset?path=${encodeURIComponent(path)}`;
}

const ASSET_TYPES = { ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

/** The snapshot and the previews, as vite.config.ts serves them for the dev
 *  route: nothing outside the derived folder is given out. */
function respondWithColdSpace(url, response) {
  if (url.pathname === "/__cold-space-snapshot") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(readFileSync(SNAPSHOT_PATH));
    return true;
  }
  if (url.pathname !== "/__cold-space-asset") return false;
  const allowed = resolve(ASSET_ROOT);
  const requested = url.searchParams.get("path");
  const path = requested ? resolve(requested) : null;
  if (!path || (path !== allowed && !path.startsWith(`${allowed}${sep}`))) {
    response.writeHead(requested ? 403 : 404);
    response.end();
    return true;
  }
  try {
    const bytes = readFileSync(path);
    response.writeHead(200, { "Content-Type": ASSET_TYPES[extname(path).toLowerCase()] ?? "image/jpeg" });
    response.end(bytes);
  } catch {
    // A preview that is not made yet: the page shows the card without it.
    response.writeHead(404);
    response.end();
  }
  return true;
}

async function servePage() {
  if (!SNAPSHOT_PATH || !ASSET_ROOT) {
    throw new Error([
      "The cold-space audit has no snapshot to show.",
      "`bun run test:browser` builds the fixture space and passes MINE_COLD_SPACE_SNAPSHOT_PATH and MINE_COLD_SPACE_ASSET_ROOT;",
      "to check a page served elsewhere, pass MINE_COLD_SPACE_AUDIT_URL.",
    ].join("\n"));
  }
  return serveProductionPage({
    name: "cold-space-audit",
    route: AUDIT_ROUTE,
    entry: routeEntry({ module: "/src/dev/ColdSpaceAuditRoute.tsx", name: "ColdSpaceAuditRoute", assetAddress: coldSpaceAssetAddress }),
    respond: respondWithColdSpace,
  });
}

async function main() {
  const served = GIVEN_AUDIT_URL ? null : await servePage();
  if (served) AUDIT_URL = served.url;
  let browser;
  try {
    const response = await fetch(AUDIT_URL, { method: "HEAD" }).catch(() => null);
    if (!response?.ok) {
      throw new Error(`Cold-space audit route is not reachable: ${AUDIT_URL}`);
    }
    browser = await chromium.launch({ headless: true });
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
    await browser?.close();
    await served?.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
