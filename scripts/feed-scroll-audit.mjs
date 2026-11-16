#!/usr/bin/env node
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { build } from "vite";

/** How long the first page of the run may take to show. */
const COLD_START_MS = 120_000;
const AUDIT_ROUTE = "/__feed-scroll-audit";
/** A page the caller serves instead, to measure it (a dev server's
 *  `/__feed-scroll-audit`, React's development build): by default the audit
 *  builds the route for production and serves it itself, as test:sidebar-strip
 *  and test:editing-perf do, so a frame is the app's, not the development
 *  build's (its checks, StrictMode's second render of every component, its
 *  performance tracks: over three times the work of a jump). */
const GIVEN_AUDIT_URL = process.env.MINE_FEED_SCROLL_AUDIT_URL;
let AUDIT_URL = GIVEN_AUDIT_URL;
const root = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = "virtual:feed-scroll-audit-entry";
const RESOLVED_ENTRY = `\0${ENTRY}`;
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "narrow", width: 900, height: 900 },
];
const SETTLE_TIMEOUT_MS = 750;
const MIN_VISIBLE_PIXEL_RATIO = 0.003;
const MAX_VIEWPORT_SETTLE_MS = 250;
const MAX_FRAME_GAP_MS = 120;
const MAX_LONG_TASK_MS = 120;
const MAX_MOUNTED_DOM_ITEMS = 240;
const HEIGHT_DRIFT_TIMEOUT_MS = 2500;

async function assertDevServerReady(url) {
  try {
    const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(COLD_START_MS) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    throw new Error(
      [
        `Feed scroll audit route is not reachable: ${url}`,
        "The Vite that serves the route did not answer.",
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
      ].join("\n"),
      { cause: error },
    );
  }
}

function waitForAnimationFrames(page, count) {
  return page.evaluate((frameCount) => new Promise((resolve) => {
    let remaining = frameCount;
    const tick = () => {
      remaining -= 1;
      if (remaining <= 0) {
        resolve(undefined);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), count);
}

async function waitForViewportPaint(page) {
  await page.waitForFunction(() => {
    const debug = window.__MINE_FEED_SCROLL_DEBUG__;
    const viewport = debug?.viewport;
    return Boolean(
      viewport &&
      viewport.reason !== "zero-viewport" &&
      viewport.layoutViewportPositionCount > 0 &&
      viewport.domViewportItemCount > 0 &&
      viewport.liveDomViewportItemCount > 0 &&
      !viewport.blankViewportRisk,
    );
  }, null, { timeout: SETTLE_TIMEOUT_MS });
}

async function markHeightDriftAuditStart(page) {
  return page.evaluate(() => {
    const startedAtMs = performance.now();
    window.__MINE_REQUEST_HEIGHT_DRIFT_AUDIT__?.();
    return startedAtMs;
  });
}

async function waitForHeightDriftReport(page, startedAtMs) {
  await page.waitForFunction((minCheckedAtMs) => {
    const report = window.__MINE_FEED_SCROLL_DEBUG__?.heightDrift;
    return Boolean(
      report &&
      report.checkedAtMs >= minCheckedAtMs &&
      report.count > 0,
    );
  }, startedAtMs, { timeout: HEIGHT_DRIFT_TIMEOUT_MS });
}

async function installPerformanceProbe(page) {
  await page.evaluate(() => {
    if (window.__MINE_FEED_SCROLL_AUDIT_PERF__?.installed) return;

    const state = {
      installed: true,
      longTaskSupported: false,
      startedAt: performance.now(),
      lastFrameAt: 0,
      frameGaps: [],
      longTasks: [],
    };

    window.__MINE_FEED_SCROLL_AUDIT_PERF__ = state;
    window.__MINE_FEED_SCROLL_AUDIT_RESET_PERF__ = () => {
      state.startedAt = performance.now();
      state.lastFrameAt = 0;
      state.frameGaps = [];
      state.longTasks = [];
    };
    window.__MINE_FEED_SCROLL_AUDIT_READ_PERF__ = () => {
      const frameGaps = state.frameGaps.slice();
      const longTasks = state.longTasks.slice();
      return {
        settleMs: performance.now() - state.startedAt,
        longTaskSupported: state.longTaskSupported,
        maxFrameGapMs: Math.max(0, ...frameGaps),
        frameGapOver50Count: frameGaps.filter((gap) => gap > 50).length,
        frameGapOver100Count: frameGaps.filter((gap) => gap > 100).length,
        longTaskCount: longTasks.length,
        maxLongTaskMs: Math.max(0, ...longTasks.map((entry) => entry.duration)),
        totalLongTaskMs: longTasks.reduce((total, entry) => total + entry.duration, 0),
      };
    };

    const tick = (now) => {
      if (state.lastFrameAt > 0) {
        state.frameGaps.push(now - state.lastFrameAt);
      }
      state.lastFrameAt = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    try {
      const observer = new PerformanceObserver((list) => {
        state.longTaskSupported = true;
        for (const entry of list.getEntries()) {
          state.longTasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
          });
        }
      });
      observer.observe({ type: "longtask", buffered: true });
      state.longTaskSupported = true;
    } catch {
      state.longTaskSupported = false;
    }
  });
}

async function resetPerformanceProbe(page) {
  await page.evaluate(() => {
    window.__MINE_FEED_SCROLL_AUDIT_RESET_PERF__?.();
  });
}

async function readPerformanceProbe(page) {
  return page.evaluate(() => {
    return window.__MINE_FEED_SCROLL_AUDIT_READ_PERF__?.() ?? {
      settleMs: 0,
      longTaskSupported: false,
      maxFrameGapMs: 0,
      frameGapOver50Count: 0,
      frameGapOver100Count: 0,
      longTaskCount: 0,
      maxLongTaskMs: 0,
      totalLongTaskMs: 0,
    };
  });
}

async function readViewportMetrics(page) {
  return page.evaluate(() => {
    const scrollElement = document.querySelector("[data-grid-scroll]");
    if (!(scrollElement instanceof HTMLElement)) {
      throw new Error("Missing [data-grid-scroll]");
    }
    const scrollRect = scrollElement.getBoundingClientRect();
    const itemNodes = Array.from(
      scrollElement.querySelectorAll("[data-feed-grid-item]"),
    ).filter((node) => node instanceof HTMLElement);
    let domViewportItemCount = 0;
    let liveDomViewportItemCount = 0;
    let skeletonDomViewportItemCount = 0;

    for (const node of itemNodes) {
      const rect = node.getBoundingClientRect();
      const overlaps =
        rect.bottom >= scrollRect.top &&
        rect.top <= scrollRect.bottom &&
        rect.right >= scrollRect.left &&
        rect.left <= scrollRect.right;
      if (!overlaps) continue;
      domViewportItemCount += 1;
      if (node.getAttribute("data-feed-grid-item-live") === "true") {
        liveDomViewportItemCount += 1;
      } else {
        skeletonDomViewportItemCount += 1;
      }
    }

    return {
      scrollTop: scrollElement.scrollTop,
      clientHeight: scrollElement.clientHeight,
      scrollHeight: scrollElement.scrollHeight,
      mountedDomItemCount: itemNodes.length,
      domViewportItemCount,
      liveDomViewportItemCount,
      skeletonDomViewportItemCount,
      debugViewport: window.__MINE_FEED_SCROLL_DEBUG__?.viewport ?? null,
    };
  });
}

async function jumpAndReadImmediateViewport(page, top) {
  return page.locator("[data-grid-scroll]").evaluate((element, nextTop) => {
    element.scrollTop = nextTop;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));

    const scrollRect = element.getBoundingClientRect();
    const itemNodes = Array.from(
      element.querySelectorAll("[data-feed-grid-item]"),
    ).filter((node) => node instanceof HTMLElement);
    let domViewportItemCount = 0;
    let liveDomViewportItemCount = 0;

    for (const node of itemNodes) {
      const rect = node.getBoundingClientRect();
      const overlaps =
        rect.bottom >= scrollRect.top &&
        rect.top <= scrollRect.bottom &&
        rect.right >= scrollRect.left &&
        rect.left <= scrollRect.right;
      if (!overlaps) continue;
      domViewportItemCount += 1;
      if (node.getAttribute("data-feed-grid-item-live") === "true") {
        liveDomViewportItemCount += 1;
      }
    }

    return {
      scrollTop: element.scrollTop,
      domViewportItemCount,
      liveDomViewportItemCount,
      blankViewportRisk:
        window.__MINE_FEED_SCROLL_DEBUG__?.viewport?.blankViewportRisk ?? null,
    };
  }, top);
}

async function readHeightDriftMetrics(page) {
  return page.evaluate(() => {
    const report = window.__MINE_FEED_SCROLL_DEBUG__?.heightDrift;
    if (!report) return null;
    return {
      status: report.status,
      count: report.count,
      exactSampleCount: report.exactSampleCount,
      fallbackSampleCount: report.fallbackSampleCount,
      p95AbsDeltaPx: report.p95AbsDeltaPx,
      maxAbsDeltaPx: report.maxAbsDeltaPx,
      softBudgetPx: report.softBudgetPx,
      hardBudgetPx: report.hardBudgetPx,
      softBudgetExceededCount: report.softBudgetExceededCount,
      hardBudgetExceededCount: report.hardBudgetExceededCount,
    };
  });
}

function pixelAt(png, x, y) {
  const index = (png.width * y + x) << 2;
  return [
    png.data[index],
    png.data[index + 1],
    png.data[index + 2],
    png.data[index + 3],
  ];
}

function quantizedKey([red, green, blue, alpha]) {
  if (alpha < 32) return "transparent";
  return `${red >> 4}:${green >> 4}:${blue >> 4}`;
}

function analyzeScreenshot(buffer) {
  const png = PNG.sync.read(buffer);
  const step = Math.max(1, Math.floor(Math.min(png.width, png.height) / 180));
  const histogram = new Map();
  let sampled = 0;

  for (let y = 0; y < png.height; y += step) {
    for (let x = 0; x < png.width; x += step) {
      const key = quantizedKey(pixelAt(png, x, y));
      histogram.set(key, (histogram.get(key) ?? 0) + 1);
      sampled += 1;
    }
  }

  let dominantCount = 0;
  for (const count of histogram.values()) {
    dominantCount = Math.max(dominantCount, count);
  }
  const dominantRatio = sampled > 0 ? dominantCount / sampled : 1;

  return {
    width: png.width,
    height: png.height,
    sampled,
    dominantRatio,
    visiblePixelRatio: 1 - dominantRatio,
  };
}

async function screenshotViewport(page) {
  const scrollElement = page.locator("[data-grid-scroll]");
  const box = await scrollElement.boundingBox();
  if (!box) {
    throw new Error("Cannot resolve [data-grid-scroll] bounding box");
  }
  const clip = {
    x: Math.max(0, box.x),
    y: Math.max(0, box.y),
    width: Math.max(1, Math.floor(box.width)),
    height: Math.max(1, Math.floor(box.height)),
  };
  const buffer = await page.screenshot({ clip });
  return analyzeScreenshot(buffer);
}

function plannedScrollPositions(maxScrollTop) {
  const ratios = [0, 0.07, 0.19, 0.42, 0.76, 0.97, 0.33, 0.88, 0.12, 0.61, 1];
  return ratios.map((ratio) => Math.max(0, Math.round(maxScrollTop * ratio)));
}

async function runViewportAudit(browser, viewport) {
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
  });
  const consoleWarnings = [];
  const forbiddenSourceRequests = [];
  page.on("console", (message) => {
    if (message.type() === "warning" || message.type() === "error") {
      consoleWarnings.push(message.text());
    }
  });
  page.on("request", (request) => {
    if (request.url().includes("__mine_forbidden_source__")) {
      forbiddenSourceRequests.push(request.url());
    }
  });

  await page.goto(AUDIT_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-feed-scroll-audit-route]");
  await page.waitForSelector("[data-grid-scroll]");
  await page.waitForFunction(
    () => typeof window.__MINE_REQUEST_HEIGHT_DRIFT_AUDIT__ === "function",
  );
  await installPerformanceProbe(page);
  await waitForViewportPaint(page);

  const metadataLink = page.locator(
    '[data-feed-grid-item-slug^="feed-scroll-audit-link-"]',
  ).first();
  await metadataLink.waitFor({ state: "visible" });
  const metadataLinkProbe = {
    graphicSurfaceCount: await metadataLink.locator("[data-card-graphic-surface]").count(),
    text: (await metadataLink.textContent()) ?? "",
  };

  const initialMetrics = await readViewportMetrics(page);
  const maxScrollTop = Math.max(
    0,
    initialMetrics.scrollHeight - initialMetrics.clientHeight,
  );
  const positions = plannedScrollPositions(maxScrollTop);
  const failures = [];
  const samples = [];

  if (metadataLinkProbe.graphicSurfaceCount !== 0) {
    failures.push("metadata-only link mounted a faux graphic surface");
  }

  // A graphic surface that derives its width from the height it is handed
  // shrinks away from the card edge as soon as the committed height and the
  // render ratio disagree. Measure it: the graphic must span its card.
  const narrowGraphicSurfaces = await page.evaluate(() => {
    const narrow = [];
    for (const item of document.querySelectorAll("[data-feed-grid-item-slug]")) {
      const surface = item.querySelector("[data-card-graphic-surface]");
      const holder = surface?.parentElement;
      if (!(surface instanceof HTMLElement) || !(holder instanceof HTMLElement)) continue;
      const style = getComputedStyle(holder);
      // Content width of whatever holds the surface: the card frame for media
      // cards, the padded content box for article cards.
      const available =
        holder.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight);
      const surfaceWidth = surface.getBoundingClientRect().width;
      if (surfaceWidth < available - 1) {
        narrow.push({
          slug: item.getAttribute("data-feed-grid-item-slug"),
          surfaceWidth: Math.round(surfaceWidth),
          available: Math.round(available),
        });
      }
    }
    return narrow;
  });
  if (narrowGraphicSurfaces.length > 0) {
    const sample = narrowGraphicSurfaces
      .slice(0, 3)
      .map((entry) => `${entry.slug} ${entry.surfaceWidth}/${entry.available}`)
      .join(", ");
    failures.push(
      `graphic surface narrower than its card on ${narrowGraphicSurfaces.length} card(s): ${sample}`,
    );
  }
  if (!metadataLinkProbe.text.includes("AI 2027 link")) {
    failures.push("metadata-only link did not render its link title");
  }

  // A ready card must be drawn at the shape of the artifact it paints.
  //
  // Both ratio fixtures state a source of 1200x800 and an artifact of 400x600,
  // so a card laid out from the source lands on 1.5 and a card laid out from
  // the artifact on 0.667 — far enough apart that no tolerance hides the
  // difference. The fallback envelope is checked separately: a ready card that
  // still calls its geometry pending has no shape at all, which is the state
  // that reads as an arbitrary crop rather than as a missing measurement.
  const artifactShapes = await page.evaluate(() => {
    const EXPECTED_ARTIFACT_RATIO = 400 / 600;
    const wrong = [];
    const pending = [];
    let measured = 0;
    for (const item of document.querySelectorAll("[data-feed-grid-item-slug]")) {
      const slug = item.getAttribute("data-feed-grid-item-slug") ?? "";
      if (!slug.includes("audit-ratio-") && !slug.includes("audit-article-ratio-")) continue;
      const surface = item.querySelector("[data-card-graphic-surface]");
      if (!(surface instanceof HTMLElement)) continue;
      if (surface.getAttribute("data-card-preview-geometry") === "pending") {
        pending.push(slug);
        measured += 1;
        continue;
      }
      const rect = surface.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      measured += 1;
      const ratio = rect.width / rect.height;
      const drift = Math.abs(ratio - EXPECTED_ARTIFACT_RATIO) / EXPECTED_ARTIFACT_RATIO;
      if (drift > 0.02) {
        wrong.push({ slug, ratio: Number(ratio.toFixed(3)), drift: Number((drift * 100).toFixed(1)) });
      }
    }
    return { wrong, pending, checked: measured };
  });
  if (artifactShapes.wrong.length > 0) {
    const sample = artifactShapes.wrong
      .slice(0, 3)
      .map((entry) => `${entry.slug} drawn at ${entry.ratio} (${entry.drift}% off)`)
      .join(", ");
    failures.push(
      `card drawn at a shape other than its artifact on ${artifactShapes.wrong.length} card(s): ${sample}`,
    );
  }
  if (artifactShapes.pending.length > 0) {
    failures.push(
      `ready card left on the placeholder envelope: ${artifactShapes.pending.slice(0, 3).join(", ")}`,
    );
  }
  {
    // Printed rather than only counted: a check that inspected nothing passes
    // silently, and a silent pass is indistinguishable from coverage.
    const inspected = artifactShapes.checked;
    const ok = artifactShapes.wrong.length === 0 && artifactShapes.pending.length === 0;
    if (inspected === 0) {
      failures.push("artifact-shape check inspected no cards");
    }
    console.log(
      `${ok && inspected > 0 ? "PASS" : "FAIL"} ${viewport.name}: every ready card drawn at its artifact's shape`
      + ` — ${inspected} card(s) inspected, ${artifactShapes.wrong.length} mis-shaped,`
      + ` ${artifactShapes.pending.length} on the placeholder envelope`,
    );
  }

  // Collage tiles are cropped into fixed slots and must keep the layout they
  // had before card geometry moved to artifact dimensions: their own ratios are
  // deliberately not the source ratios, and nothing about this change may
  // reshape them.
  const collageTileShapes = await page.evaluate(() => {
    const shapes = [];
    for (const item of document.querySelectorAll("[data-feed-grid-item-slug]")) {
      const tiles = item.querySelectorAll("[data-card-media-tile]");
      // Only the 2x2 grid: with three tiles the first one deliberately spans
      // both rows, so its slot is not square by design.
      if (tiles.length !== 4) continue;
      for (const tile of tiles) {
        const rect = tile.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        shapes.push({
          slug: item.getAttribute("data-feed-grid-item-slug"),
          ratio: rect.width / rect.height,
        });
      }
      if (shapes.length >= 12) break;
    }
    return shapes;
  });
  const skewedTiles = collageTileShapes.filter(
    (entry) => entry.ratio < 0.85 || entry.ratio > 1.18,
  );
  if (collageTileShapes.length > 0 && skewedTiles.length > 0) {
    const sample = skewedTiles
      .slice(0, 3)
      .map((entry) => `${entry.slug} ${entry.ratio.toFixed(2)}`)
      .join(", ");
    failures.push(
      `collage tiles left their square slots on ${skewedTiles.length} tile(s): ${sample}`,
    );
  }

  for (const top of positions) {
    await resetPerformanceProbe(page);
    const immediateMetrics = await jumpAndReadImmediateViewport(page, top);
    await waitForAnimationFrames(page, 1);
    const firstFrameMetrics = await readViewportMetrics(page);
    const performanceSample = await readPerformanceProbe(page);
    const firstFramePixels = await screenshotViewport(page);
    await waitForViewportPaint(page);
    await waitForAnimationFrames(page, 2);

    const metrics = await readViewportMetrics(page);
    const forbiddenDomSources = await page.locator(
      '[data-grid-scroll] img[src*="__mine_forbidden_source__"], [data-grid-scroll] video[src*="__mine_forbidden_source__"]',
    ).count();
    const pixels = await screenshotViewport(page);
    await page.waitForFunction(
      () => typeof window.__MINE_REQUEST_HEIGHT_DRIFT_AUDIT__ === "function",
    );
    const heightDriftStartedAtMs = await markHeightDriftAuditStart(page);
    await waitForHeightDriftReport(page, heightDriftStartedAtMs);
    const heightDrift = await readHeightDriftMetrics(page);
    samples.push({
      requestedTop: top,
      scrollTop: Math.round(metrics.scrollTop),
      immediateDomViewportItemCount: immediateMetrics.domViewportItemCount,
      immediateLiveDomViewportItemCount: immediateMetrics.liveDomViewportItemCount,
      firstFrameDomViewportItemCount: firstFrameMetrics.domViewportItemCount,
      firstFrameLiveDomViewportItemCount: firstFrameMetrics.liveDomViewportItemCount,
      firstFrameVisiblePixelRatio: Number(firstFramePixels.visiblePixelRatio.toFixed(4)),
      mountedDomItemCount: metrics.mountedDomItemCount,
      domViewportItemCount: metrics.domViewportItemCount,
      liveDomViewportItemCount: metrics.liveDomViewportItemCount,
      skeletonDomViewportItemCount: metrics.skeletonDomViewportItemCount,
      visiblePixelRatio: Number(pixels.visiblePixelRatio.toFixed(4)),
      settleMs: Number(performanceSample.settleMs.toFixed(1)),
      maxFrameGapMs: Number(performanceSample.maxFrameGapMs.toFixed(1)),
      frameGapOver50Count: performanceSample.frameGapOver50Count,
      longTaskSupported: performanceSample.longTaskSupported,
      longTaskCount: performanceSample.longTaskCount,
      maxLongTaskMs: Number(performanceSample.maxLongTaskMs.toFixed(1)),
      heightDrift,
      reason: metrics.debugViewport?.reason ?? "missing-debug",
      forbiddenDomSources,
    });

    if (immediateMetrics.domViewportItemCount === 0) {
      failures.push(`native scroll exposed an empty DOM viewport at ${top}`);
    }
    if (immediateMetrics.liveDomViewportItemCount === 0) {
      failures.push(`native scroll exposed no live cards at ${top}`);
    }
    if (firstFrameMetrics.domViewportItemCount === 0) {
      failures.push(`first animation frame has no mounted cards at ${top}`);
    }
    if (firstFrameMetrics.liveDomViewportItemCount === 0) {
      failures.push(`first animation frame has no live cards at ${top}`);
    }
    if (firstFramePixels.visiblePixelRatio < MIN_VISIBLE_PIXEL_RATIO) {
      failures.push(
        `first animation frame is visually blank at ${top}: visiblePixelRatio=${firstFramePixels.visiblePixelRatio.toFixed(4)}`,
      );
    }
    if (metrics.debugViewport?.blankViewportRisk) {
      failures.push(`blank viewport risk at ${top}: ${metrics.debugViewport.reason}`);
    }
    if (metrics.domViewportItemCount === 0) {
      failures.push(`no mounted DOM items in viewport at ${top}`);
    }
    if (metrics.liveDomViewportItemCount === 0) {
      failures.push(`no live cards in viewport at ${top}`);
    }
    if (pixels.visiblePixelRatio < MIN_VISIBLE_PIXEL_RATIO) {
      failures.push(
        `screenshot is visually blank at ${top}: visiblePixelRatio=${pixels.visiblePixelRatio.toFixed(4)}`,
      );
    }
    if (metrics.mountedDomItemCount > MAX_MOUNTED_DOM_ITEMS) {
      failures.push(
        `DOM window inflated at ${top}: mountedDomItemCount=${metrics.mountedDomItemCount}, max=${MAX_MOUNTED_DOM_ITEMS}`,
      );
    }
    if (performanceSample.settleMs > MAX_VIEWPORT_SETTLE_MS) {
      failures.push(
        `viewport settle exceeded budget at ${top}: settleMs=${performanceSample.settleMs.toFixed(1)}, max=${MAX_VIEWPORT_SETTLE_MS}`,
      );
    }
    if (performanceSample.maxFrameGapMs > MAX_FRAME_GAP_MS) {
      failures.push(
        `frame gap exceeded budget at ${top}: maxFrameGapMs=${performanceSample.maxFrameGapMs.toFixed(1)}, max=${MAX_FRAME_GAP_MS}`,
      );
    }
    if (performanceSample.maxLongTaskMs > MAX_LONG_TASK_MS) {
      failures.push(
        `long task exceeded budget at ${top}: maxLongTaskMs=${performanceSample.maxLongTaskMs.toFixed(1)}, max=${MAX_LONG_TASK_MS}`,
      );
    }
    if (forbiddenDomSources > 0) {
      failures.push(`source media entered the rendered Grid DOM at ${top}`);
    }
    if (!heightDrift) {
      failures.push(`missing height drift report at ${top}`);
    } else if (heightDrift.status !== "ok") {
      failures.push(
        [
          `height drift over budget at ${top}: status=${heightDrift.status}`,
          `count=${heightDrift.count}`,
          `exact=${heightDrift.exactSampleCount}`,
          `fallback=${heightDrift.fallbackSampleCount}`,
          `p95=${heightDrift.p95AbsDeltaPx}px`,
          `max=${heightDrift.maxAbsDeltaPx}px`,
          `soft=${heightDrift.softBudgetPx}px`,
          `hard=${heightDrift.hardBudgetPx}px`,
        ].join(", "),
      );
    }
  }

  await page.close();

  if (consoleWarnings.length > 0) {
    failures.push(`unexpected browser warnings/errors: ${consoleWarnings.slice(0, 5).join(" | ")}`);
  }
  if (forbiddenSourceRequests.length > 0) {
    failures.push(
      `Grid requested source media: ${forbiddenSourceRequests.slice(0, 5).join(" | ")}`,
    );
  }

  return {
    viewport: viewport.name,
    maxScrollTop,
    metadataLinkProbe,
    samples,
    consoleWarnings,
    forbiddenSourceRequests,
    failures,
  };
}

// ─── The page ───────────────────────────────────────────────────────────────

/** The route alone, as the app's entry sets the page up before it (main.tsx):
 *  the stored theme, motion level, corners, spacing and fonts, the audit's
 *  stand-in for the asset protocol, StrictMode and the tooltip provider. */
const entryPlugin = {
  name: "feed-scroll-audit-entry",
  config(config) {
    config.build ??= {};
    config.build.rollupOptions = { ...(config.build.rollupOptions ?? {}), input: { feed: ENTRY } };
  },
  resolveId(id) { return id === ENTRY ? RESOLVED_ENTRY : undefined; },
  load(id) {
    if (id !== RESOLVED_ENTRY) return undefined;
    return `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import "/src/styles/global.css";
      import { TooltipProvider } from "/src/components/ui/tooltip.tsx";
      import { applyTheme, getStoredTheme } from "/src/lib/themeMode.ts";
      import { installMotionLevel } from "/src/lib/motion.ts";
      import { applyCardRadius, getStoredCardRadius } from "/src/lib/cardRadius.ts";
      import { applyDensity, getStoredDensity } from "/src/lib/density.ts";
      import { applyContentFont, applyInterfaceFont, getStoredContentFont, getStoredInterfaceFont } from "/src/lib/fontChoice.ts";
      import { FeedScrollAuditRoute } from "/src/dev/FeedScrollAuditRoute.tsx";
      applyTheme(getStoredTheme());
      installMotionLevel();
      applyCardRadius(getStoredCardRadius());
      applyDensity(getStoredDensity());
      applyInterfaceFont(getStoredInterfaceFont());
      applyContentFont(getStoredContentFont());
      // The route's pictures are the public folder's (main.tsx, installAuditTauriMocks).
      window.__TAURI_INTERNALS__ = { convertFileSrc: (filePath, protocol = "asset") => {
        const path = filePath.startsWith("//") ? filePath.slice(1) : filePath;
        return path.startsWith("/feed-scroll-audit/") ? path : protocol + "://localhost/" + encodeURIComponent(path);
      } };
      createRoot(document.getElementById("root")).render(
        React.createElement(React.StrictMode, null,
          React.createElement(TooltipProvider, null, React.createElement(FeedScrollAuditRoute))));`;
  },
};

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm" };

/** Builds the route for production into a folder of the run and serves it
 *  at AUDIT_ROUTE; resolves to its address and its teardown. */
async function servePage() {
  const folder = mkdtempSync(join(tmpdir(), "mine-feed-scroll-"));
  try {
    await build({
      root,
      configFile: join(root, "vite.config.ts"),
      mode: "production",
      logLevel: "warn",
      plugins: [entryPlugin],
      build: { outDir: folder, emptyOutDir: true, manifest: true, reportCompressedSize: false, chunkSizeWarningLimit: 100_000 },
    });
    const manifest = JSON.parse(readFileSync(join(folder, ".vite/manifest.json"), "utf8"));
    const chunk = Object.values(manifest).find((item) => item.isEntry);
    if (!chunk) throw new Error("The build has no entry");
    writeFileSync(join(folder, "feed.html"), `<!doctype html><html><head><meta charset="utf-8">${(chunk.css ?? []).map((css) => `<link rel="stylesheet" href="/${css}">`).join("")}</head>`
      + `<body><div id="root"></div><script type="module" src="/${chunk.file}"></script></body></html>`);
  } catch (error) {
    rmSync(folder, { recursive: true, force: true });
    throw error;
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const name = url.pathname === AUDIT_ROUTE ? "/feed.html" : decodeURIComponent(url.pathname);
    const path = normalize(join(folder, name));
    if (!path.startsWith(`${folder}${sep}`) || !existsSync(path) || !statSync(path).isFile()) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream" });
    createReadStream(path).pipe(response);
  });
  await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  return {
    url: `http://127.0.0.1:${server.address().port}${AUDIT_ROUTE}`,
    close: async () => {
      await new Promise((done) => server.close(done));
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

/** The feed's layout at Spacing 8 and 2 (user's decision of 15.11.2026;
 *  SPEC_FEED_DISPLAY.md, Д17): the gaps between cards, the feed's edges and
 *  the number of columns are the token, in the production build. */
const SPACING_STEPS = [8, 2];
async function runSpacingAudit(browser, step) {
  const viewport = VIEWPORTS[0];
  const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
  await page.addInitScript((value) => {
    localStorage.setItem("mine.spacing", String(value));
    localStorage.setItem("mine.spacing.steps", "32-24-16-8-2");
  }, step);
  const failures = [];
  try {
    await page.goto(AUDIT_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-grid-scroll] [data-feed-grid-item-live="true"]');
    await waitForViewportPaint(page);
    // The feed settled: the same cards in the same places over ten frames.
    await page.evaluate(() => new Promise((resolve) => {
      let last = "";
      let same = 0;
      const tick = () => {
        const now = [...document.querySelectorAll('[data-grid-scroll] [data-feed-grid-item-live="true"]')]
          .map((node) => { const rect = node.getBoundingClientRect(); return `${Math.round(rect.left)},${Math.round(rect.top)}`; }).join(";");
        same = now === last ? same + 1 : 0;
        last = now;
        if (same >= 10) resolve();
        else requestAnimationFrame(tick);
      };
      tick();
    }));
    const read = await page.evaluate(() => {
      const scroll = document.querySelector("[data-grid-scroll]");
      const box = scroll.getBoundingClientRect();
      const style = getComputedStyle(scroll);
      const items = [...scroll.querySelectorAll('[data-feed-grid-item-live="true"]')]
        .map((node) => node.getBoundingClientRect())
        .filter((rect) => rect.bottom > box.top && rect.top < box.bottom)
        .map((rect) => ({ left: rect.left - box.left, right: rect.right - box.left, top: rect.top, bottom: rect.bottom }));
      return {
        token: getComputedStyle(document.documentElement).getPropertyValue("--edge-rhythm").trim(),
        padding: [style.paddingLeft, style.paddingRight],
        clientWidth: scroll.clientWidth,
        items,
      };
    });
    if (read.token !== `${step}px`) failures.push(`--edge-rhythm is ${read.token}, not ${step}px`);
    if (read.padding.some((value) => value !== `${step}px`)) failures.push(`the feed's edges are ${read.padding.join(" and ")}, not ${step}px`);
    const lefts = [...new Set(read.items.map((item) => Math.round(item.left)))].sort((a, b) => a - b);
    const content = read.clientWidth - 2 * step;
    const expected = Math.max(2, Math.floor((content + step) / (220 + step)));
    if (lefts.length !== expected) failures.push(`${lefts.length} columns on screen, not ${expected}`);
    if (lefts[0] !== step) failures.push(`the first column starts ${lefts[0]} px in, not ${step}`);
    const rightmost = Math.max(...read.items.map((item) => Math.round(item.right)));
    if (rightmost !== read.clientWidth - step) failures.push(`the last column ends ${read.clientWidth - rightmost} px before the edge, not ${step}`);
    const byColumn = new Map();
    for (const item of read.items) {
      const left = Math.round(item.left);
      byColumn.set(left, [...(byColumn.get(left) ?? []), item].sort((a, b) => a.top - b.top));
    }
    const ordered = [...byColumn.entries()].sort(([a], [b]) => a - b);
    for (let index = 1; index < ordered.length; index += 1) {
      const gap = ordered[index][0] - Math.round(ordered[index - 1][1][0].right);
      if (gap !== step) failures.push(`${gap} px between columns ${index} and ${index + 1}, not ${step}`);
    }
    for (const [left, cards] of ordered) {
      for (let index = 1; index < cards.length; index += 1) {
        const gap = Math.round(cards[index].top - cards[index - 1].bottom);
        if (gap !== step) failures.push(`${gap} px between two cards of the column at ${left}, not ${step}`);
      }
    }
    return { viewport: `${viewport.name} at Spacing ${step}`, columns: lefts.length, cardsOnScreen: read.items.length, failures };
  } finally {
    await page.close();
  }
}

async function main() {
  const page = GIVEN_AUDIT_URL ? null : await servePage();
  if (page) AUDIT_URL = page.url;
  let browser;
  try {
    await assertDevServerReady(AUDIT_URL);
    browser = await chromium.launch({ headless: true });
    const results = [];
    for (const viewport of VIEWPORTS) {
      results.push(await runViewportAudit(browser, viewport));
    }
    for (const step of SPACING_STEPS) {
      results.push(await runSpacingAudit(browser, step));
    }

    const failures = results.flatMap((result) =>
      result.failures.map((failure) => `${result.viewport}: ${failure}`),
    );

    console.log(JSON.stringify(results, null, 2));

    if (failures.length > 0) {
      throw new Error(`Feed scroll audit failed:\n${failures.join("\n")}`);
    }
    console.log("\nAll feed scroll audit checks passed.");
  } finally {
    await browser?.close();
    await page?.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
