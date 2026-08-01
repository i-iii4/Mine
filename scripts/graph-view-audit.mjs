#!/usr/bin/env node
import { chromium } from "playwright";
import { PNG } from "pngjs";

const DEFAULT_AUDIT_URL = "http://127.0.0.1:1420/__graph-audit";
const AUDIT_URL = process.env.MINE_GRAPH_AUDIT_URL ?? DEFAULT_AUDIT_URL;
const FIRST_PAINT_BUDGET_MS = 1_000;
const PAINT_WAIT_TIMEOUT_MS = 3_000;
const MAX_UNIQUE_IMAGE_REQUESTS = 48;
const MAX_LONG_TASK_MS = 100;
const MAX_P95_FRAME_MS = 32;

async function assertDevServerReady() {
  try {
    const response = await fetch(AUDIT_URL, { method: "HEAD" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new Error([
      `Graph audit route is not reachable: ${AUDIT_URL}`,
      "Start the existing dev app first, then rerun `bun run test:graph`.",
      `Original error: ${error instanceof Error ? error.message : String(error)}`,
    ].join("\n"));
  }
}

async function waitForGraphPaint(page, requireSettledFrame = false) {
  await page.waitForSelector("[data-graph-view] canvas");
  try {
    await page.waitForFunction((requireSettled) => {
      const canvas = document.querySelector("[data-graph-view] canvas");
      if (!(canvas instanceof HTMLCanvasElement) || canvas.width <= 0 || canvas.height <= 0) {
        return false;
      }
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return false;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const stride = Math.max(4, Math.floor(Math.min(canvas.width, canvas.height) / 180) * 4);
      let minX = canvas.width;
      let maxX = 0;
      let minY = canvas.height;
      let maxY = 0;
      for (let index = 3; index < pixels.length; index += stride) {
        if (pixels[index] <= 24) continue;
        if (!requireSettled) return true;
        const pixelIndex = (index - 3) / 4;
        const x = pixelIndex % canvas.width;
        const y = Math.floor(pixelIndex / canvas.width);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      return maxX - minX >= canvas.width * 0.45
        && maxY - minY >= canvas.height * 0.45;
    }, requireSettledFrame, { timeout: PAINT_WAIT_TIMEOUT_MS });
  } catch (error) {
    const diagnostics = await page.evaluate(() => {
      const view = document.querySelector("[data-graph-view]");
      const canvas = view?.querySelector("canvas");
      return {
        audit: window.__MINE_GRAPH_AUDIT__ ?? null,
        route: view?.getAttribute("data-graph-snapshot-route") ?? null,
        canvas: canvas instanceof HTMLCanvasElement
          ? {
              width: canvas.width,
              height: canvas.height,
              clientWidth: canvas.clientWidth,
              clientHeight: canvas.clientHeight,
            }
          : null,
        bodyText: document.body.textContent?.trim() ?? "",
      };
    });
    throw new Error(
      `Graph paint timed out: ${JSON.stringify(diagnostics)}\n`
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function nonBackgroundRatio(buffer) {
  const png = PNG.sync.read(buffer);
  const step = Math.max(1, Math.floor(Math.min(png.width, png.height) / 180));
  const histogram = new Map();
  let sampled = 0;
  for (let y = 0; y < png.height; y += step) {
    for (let x = 0; x < png.width; x += step) {
      const index = (png.width * y + x) << 2;
      const key = `${png.data[index] >> 3}:${png.data[index + 1] >> 3}:${png.data[index + 2] >> 3}`;
      histogram.set(key, (histogram.get(key) ?? 0) + 1);
      sampled += 1;
    }
  }
  const dominant = Math.max(0, ...histogram.values());
  return sampled > 0 ? 1 - dominant / sampled : 0;
}

function findAuditCardPixel(buffer) {
  const png = PNG.sync.read(buffer);
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const index = (png.width * y + x) << 2;
      const red = png.data[index];
      const green = png.data[index + 1];
      const blue = png.data[index + 2];
      if (red > 220 && green >= 45 && green <= 130 && blue < 110) {
        return { x, y };
      }
    }
  }
  return null;
}

function changedPixelRatio(beforeBuffer, afterBuffer) {
  const before = PNG.sync.read(beforeBuffer);
  const after = PNG.sync.read(afterBuffer);
  if (before.width !== after.width || before.height !== after.height) return 1;
  let changed = 0;
  const pixelCount = before.width * before.height;
  for (let index = 0; index < before.data.length; index += 4) {
    if (
      before.data[index] !== after.data[index]
      || before.data[index + 1] !== after.data[index + 1]
      || before.data[index + 2] !== after.data[index + 2]
      || before.data[index + 3] !== after.data[index + 3]
    ) {
      changed += 1;
    }
  }
  return pixelCount > 0 ? changed / pixelCount : 0;
}

async function canvasScreenshot(page) {
  const dataUrl = await page.locator("[data-graph-view] canvas").first().evaluate((canvas) => {
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Graph canvas is missing");
    return canvas.toDataURL("image/png");
  });
  return Buffer.from(dataUrl.split(",", 2)[1], "base64");
}

async function assertNonblank(page, label) {
  const ratio = nonBackgroundRatio(await canvasScreenshot(page));
  if (ratio < 0.0005) {
    throw new Error(`${label}: graph canvas is blank (visible ratio ${ratio.toFixed(6)})`);
  }
  return ratio;
}

async function assertSemanticLinkPaint(page, label) {
  const stats = await page.evaluate(() => window.__MINE_GRAPH_LINK_PAINT__ ?? null);
  if (!stats || stats.curvedLinks === 0 || stats.dashedLinks === 0) {
    throw new Error(`${label}: semantic graph links were not painted: ${JSON.stringify(stats)}`);
  }
  return stats;
}

async function assertControlsFit(page, label) {
  const controlsLocator = page.locator("[data-graph-controls]");
  if (await controlsLocator.count() === 0) return;
  const result = await controlsLocator.evaluate((controls) => {
    const viewportWidth = document.documentElement.clientWidth;
    const rect = controls.getBoundingClientRect();
    const children = Array.from(controls.children).map((child) => child.getBoundingClientRect());
    const overlaps = [];
    for (let index = 0; index < children.length; index += 1) {
      for (let other = index + 1; other < children.length; other += 1) {
        const a = children[index];
        const b = children[other];
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapX > 0.5 && overlapY > 0.5) overlaps.push([index, other]);
      }
    }
    return {
      withinViewport: rect.left >= 0 && rect.right <= viewportWidth,
      horizontalOverflow: controls.scrollWidth > controls.clientWidth + 1,
      overlaps,
    };
  });
  if (!result.withinViewport || result.horizontalOverflow || result.overlaps.length > 0) {
    throw new Error(`${label}: graph controls overlap or overflow: ${JSON.stringify(result)}`);
  }
}

async function assertRemovedGraphControls(page, label) {
  const visible = await page.evaluate(() => ({
    search: document.querySelector('[aria-label="Search graph"]') !== null,
    filters: document.querySelector('[aria-label="Graph filters"]') !== null,
    scope: document.querySelector('[aria-label="Graph scope"]') !== null,
    unresolved: Array.from(document.querySelectorAll("*"))
      .some((node) => node.textContent?.trim() === "Unresolved"),
  }));
  if (Object.values(visible).some(Boolean)) {
    throw new Error(`${label}: removed Graph controls are visible: ${JSON.stringify(visible)}`);
  }
}

async function installFrameProbe(page) {
  await page.evaluate(() => {
    const state = { frames: [], longTasks: [] };
    window.__MINE_GRAPH_FRAME_PROBE__ = state;
    let last = performance.now();
    const tick = (now) => {
      state.frames.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.longTasks.push(entry.duration);
      });
      observer.observe({ type: "longtask", buffered: false });
    } catch {
      // Long Task API is optional in embedded Chromium variants.
    }
  });
}

async function resetFrameProbe(page) {
  await page.evaluate(() => {
    const state = window.__MINE_GRAPH_FRAME_PROBE__;
    if (!state) return;
    state.frames = [];
    state.longTasks = [];
  });
}

async function readFrameProbe(page) {
  return page.evaluate(() => {
    const state = window.__MINE_GRAPH_FRAME_PROBE__ ?? { frames: [], longTasks: [] };
    const frames = state.frames.slice().sort((a, b) => a - b);
    const p95 = frames[Math.max(0, Math.ceil(frames.length * 0.95) - 1)] ?? 0;
    return {
      frameCount: frames.length,
      p95FrameMs: p95,
      maxLongTaskMs: Math.max(0, ...state.longTasks),
    };
  });
}

async function exerciseZoomAndPan(page) {
  const canvas = page.locator("[data-graph-view] canvas").first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Graph canvas has no bounding box");
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  await resetFrameProbe(page);
  await page.mouse.move(centerX, centerY);
  for (let index = 0; index < 10; index += 1) {
    await page.mouse.wheel(0, index % 2 === 0 ? -80 : 80);
  }
  await page.mouse.down();
  await page.mouse.move(centerX + 100, centerY + 30, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  return readFrameProbe(page);
}

async function verifyCardHoverDoesNotMutateCanvas(page) {
  await page.waitForTimeout(3_700);
  const canvas = page.locator("[data-graph-view] canvas").first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Graph canvas has no bounding box for hover verification");
  const before = await canvasScreenshot(page);
  const target = findAuditCardPixel(before);
  if (!target) throw new Error("Could not locate the red audit thumbnail in graph pixels");

  await page.mouse.move(box.x + target.x, box.y + target.y);
  await page.waitForSelector("[data-graph-card-hover-preview]", { timeout: 800 });
  const after = await canvasScreenshot(page);
  const changedRatio = changedPixelRatio(before, after);
  if (changedRatio > 0.0001) {
    throw new Error(`Card hover mutated ${(changedRatio * 100).toFixed(4)}% of canvas pixels`);
  }
  await page.mouse.move(box.x + 8, box.y + 8);
  return changedRatio;
}

async function runTheme(browser, theme) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(() => {
    window.__MINE_GRAPH_LINK_PAINT__ = {
      curvedLinks: 0,
      dashedLinks: 0,
    };
    const originalQuadraticCurveTo = CanvasRenderingContext2D.prototype.quadraticCurveTo;
    CanvasRenderingContext2D.prototype.quadraticCurveTo = function (...args) {
      window.__MINE_GRAPH_LINK_PAINT__.curvedLinks += 1;
      return originalQuadraticCurveTo.apply(this, args);
    };
    const originalSetLineDash = CanvasRenderingContext2D.prototype.setLineDash;
    CanvasRenderingContext2D.prototype.setLineDash = function (segments) {
      if (segments.some((segment) => segment > 0)) {
        window.__MINE_GRAPH_LINK_PAINT__.dashedLinks += 1;
      }
      return originalSetLineDash.call(this, segments);
    };
  });
  const imageRequests = new Set();
  const consoleErrors = [];
  page.on("request", (request) => {
    if (request.resourceType() === "image") imageRequests.add(request.url());
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const startedAt = performance.now();
  await page.goto(`${AUDIT_URL}?theme=${theme}`, { waitUntil: "domcontentloaded" });
  await waitForGraphPaint(page, true);
  const firstPaintMs = performance.now() - startedAt;
  if (firstPaintMs > FIRST_PAINT_BUDGET_MS) {
    throw new Error(`${theme}: first graph paint ${firstPaintMs.toFixed(1)}ms exceeds ${FIRST_PAINT_BUDGET_MS}ms`);
  }
  const firstPaintRatio = await assertNonblank(page, `${theme} first paint`);
  const semanticLinkPaint = await assertSemanticLinkPaint(page, `${theme} first paint`);
  await assertRemovedGraphControls(page, `${theme} desktop`);
  await assertControlsFit(page, `${theme} desktop`);
  await installFrameProbe(page);
  const hoverChangedRatio = theme === "dark"
    ? await verifyCardHoverDoesNotMutateCanvas(page)
    : null;

  const canvas = page.locator("[data-graph-view] canvas").first();
  await canvas.evaluate((node) => node.setAttribute("data-audit-canvas-identity", "preserve"));
  await page.getByRole("button", { name: "Collection audit" }).click();
  await page.waitForFunction(() => window.__MINE_GRAPH_AUDIT__?.lastScope?.kind === "current_route");
  await page.waitForSelector('[data-graph-view][data-graph-snapshot-route="Design"]');
  await waitForGraphPaint(page);
  if (await canvas.getAttribute("data-audit-canvas-identity") !== "preserve") {
    throw new Error(`${theme}: route switch remounted the graph canvas`);
  }
  const routePaintRatio = await assertNonblank(page, `${theme} route switch`);

  await page.setViewportSize({ width: 520, height: 760 });
  await page.waitForFunction(() => {
    const canvasNode = document.querySelector("[data-graph-view] canvas");
    if (!(canvasNode instanceof HTMLCanvasElement)) return false;
    const rect = canvasNode.getBoundingClientRect();
    return Math.abs(rect.width - 520) <= 2 && Math.abs(rect.height - 760) <= 2;
  });
  if (await canvas.getAttribute("data-audit-canvas-identity") !== "preserve") {
    throw new Error(`${theme}: resize remounted the graph canvas`);
  }
  await waitForGraphPaint(page);
  await assertControlsFit(page, `${theme} narrow`);
  const narrowPaintRatio = await assertNonblank(page, `${theme} narrow`);

  await page.getByRole("button", { name: "Library audit" }).click();
  await page.waitForFunction(() => window.__MINE_GRAPH_AUDIT__?.lastScope?.kind === "library");
  await page.waitForSelector('[data-graph-view][data-graph-snapshot-route="__library__"]');
  await waitForGraphPaint(page);
  await assertRemovedGraphControls(page, `${theme} library`);

  const interaction = await exerciseZoomAndPan(page);
  if (interaction.frameCount > 5 && interaction.p95FrameMs > MAX_P95_FRAME_MS) {
    throw new Error(`${theme}: p95 frame ${interaction.p95FrameMs.toFixed(1)}ms exceeds ${MAX_P95_FRAME_MS}ms`);
  }
  if (interaction.maxLongTaskMs > MAX_LONG_TASK_MS) {
    throw new Error(`${theme}: long task ${interaction.maxLongTaskMs.toFixed(1)}ms exceeds ${MAX_LONG_TASK_MS}ms`);
  }

  if (imageRequests.size > MAX_UNIQUE_IMAGE_REQUESTS) {
    throw new Error(`${theme}: ${imageRequests.size} unique image requests exceeds ${MAX_UNIQUE_IMAGE_REQUESTS}`);
  }
  const relevantErrors = consoleErrors.filter((message) => !message.includes("favicon"));
  if (relevantErrors.length > 0) {
    throw new Error(`${theme}: browser console errors:\n${relevantErrors.join("\n")}`);
  }

  await page.close();
  return {
    theme,
    firstPaintMs: Number(firstPaintMs.toFixed(1)),
    firstPaintRatio: Number(firstPaintRatio.toFixed(5)),
    routePaintRatio: Number(routePaintRatio.toFixed(5)),
    narrowPaintRatio: Number(narrowPaintRatio.toFixed(5)),
    uniqueImageRequests: imageRequests.size,
    semanticLinkPaint,
    hoverChangedRatio,
    ...interaction,
  };
}

await assertDevServerReady();
const browser = await chromium.launch({ headless: true });
try {
  const results = [];
  for (const theme of ["dark", "light"]) {
    results.push(await runTheme(browser, theme));
  }
  console.log(JSON.stringify({ ok: true, url: AUDIT_URL, results }, null, 2));
} finally {
  await browser.close();
}
