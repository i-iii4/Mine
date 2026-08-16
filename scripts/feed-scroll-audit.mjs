#!/usr/bin/env node
import { chromium } from "playwright";
import { PNG } from "pngjs";

const DEFAULT_AUDIT_URL = "http://127.0.0.1:1420/__feed-scroll-audit";
const AUDIT_URL = process.env.MINE_FEED_SCROLL_AUDIT_URL ?? DEFAULT_AUDIT_URL;
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
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    throw new Error(
      [
        `Feed scroll audit route is not reachable: ${url}`,
        "Start the existing dev app first, then rerun `bun run test:feed-scroll`.",
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
      ].join("\n"),
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

async function main() {
  await assertDevServerReady(AUDIT_URL);

  const browser = await chromium.launch({ headless: true });
  try {
    const results = [];
    for (const viewport of VIEWPORTS) {
      results.push(await runViewportAudit(browser, viewport));
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
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
