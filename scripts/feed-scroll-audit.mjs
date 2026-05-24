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
  page.on("console", (message) => {
    if (message.type() === "warning" || message.type() === "error") {
      consoleWarnings.push(message.text());
    }
  });

  await page.goto(AUDIT_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-feed-scroll-audit-route]");
  await page.waitForSelector("[data-grid-scroll]");
  await installPerformanceProbe(page);
  await waitForViewportPaint(page);

  const initialMetrics = await readViewportMetrics(page);
  const maxScrollTop = Math.max(
    0,
    initialMetrics.scrollHeight - initialMetrics.clientHeight,
  );
  const positions = plannedScrollPositions(maxScrollTop);
  const failures = [];
  const samples = [];

  for (const top of positions) {
    await resetPerformanceProbe(page);
    await page.locator("[data-grid-scroll]").evaluate((element, nextTop) => {
      element.scrollTop = nextTop;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    }, top);
    await waitForViewportPaint(page);
    await waitForAnimationFrames(page, 2);

    const metrics = await readViewportMetrics(page);
    const performanceSample = await readPerformanceProbe(page);
    const pixels = await screenshotViewport(page);
    samples.push({
      requestedTop: top,
      scrollTop: Math.round(metrics.scrollTop),
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
      reason: metrics.debugViewport?.reason ?? "missing-debug",
    });

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
  }

  await page.close();

  if (consoleWarnings.length > 0) {
    failures.push(`unexpected browser warnings/errors: ${consoleWarnings.slice(0, 5).join(" | ")}`);
  }

  return {
    viewport: viewport.name,
    maxScrollTop,
    samples,
    consoleWarnings,
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
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
