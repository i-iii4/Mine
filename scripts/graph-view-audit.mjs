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
// A switch of the extra links redraws the new lines and stops (ГП4); a
// restarted simulation draws a frame on every tick for seconds.
const MAX_LINK_SWITCH_FRAMES = 5;

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
      // A collapse detector, not a layout-quality gate. The force layout is
      // sensitive to its parameters, so any threshold calibrated to how one
      // fixture happened to settle fails on non-regressions — the previous
      // 45% did exactly that, red at 43.8% while the graph looked fine. What
      // this must catch is the degenerate outcome only: every node painted in
      // one clump. A real layout spans 40–95% of the canvas; a collapsed one
      // spans a few percent. 10% separates the two with a wide margin on both
      // sides and no opinion about aesthetics.
      return maxX - minX >= canvas.width * 0.1
        && maxY - minY >= canvas.height * 0.1;
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

function changedPixels(beforeBuffer, afterBuffer, maskBuffer) {
  const before = PNG.sync.read(beforeBuffer);
  const after = PNG.sync.read(afterBuffer);
  const mask = PNG.sync.read(maskBuffer);
  if (before.width !== after.width || before.height !== after.height
    || before.width !== mask.width || before.height !== mask.height) {
    throw new Error("Card hover changed the canvas dimensions");
  }
  let changed = 0;
  let outsideOutline = 0;
  const outsideSamples = [];
  const pixelCount = before.width * before.height;
  for (let index = 0; index < before.data.length; index += 4) {
    if (
      before.data[index] !== after.data[index]
      || before.data[index + 1] !== after.data[index + 1]
      || before.data[index + 2] !== after.data[index + 2]
      || before.data[index + 3] !== after.data[index + 3]
    ) {
      changed += 1;
      if (mask.data[index + 3] === 0) {
        outsideOutline += 1;
        if (outsideSamples.length < 8) outsideSamples.push({
          x: (index / 4) % before.width, y: Math.floor(index / 4 / before.width),
          before: [...before.data.slice(index, index + 4)], after: [...after.data.slice(index, index + 4)],
        });
      }
    }
  }
  return { ratio: pixelCount > 0 ? changed / pixelCount : 0, outsideOutline, outsideSamples };
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

async function waitForGraphRest(page, canvas) {
  // A fixed delay races the force simulation (its cooldown is eight seconds).
  // Pixels can look stable while subpixel coordinates still drift. Observe
  // both exact drawing coordinates and pixels before comparing hover paint.
  await canvas.evaluate((node) => {
    const context = node.getContext("2d");
    const originalClearRect = context.clearRect;
    const originalDrawImage = context.drawImage;
    let coordinates = [];
    const probe = { geometry: null, geometrySince: performance.now() };
    context.drawImage = function (image, ...args) {
      coordinates.push(args);
      return originalDrawImage.call(this, image, ...args);
    };
    context.clearRect = function (...args) {
      if (coordinates.length > 0) {
        const geometry = JSON.stringify(coordinates);
        if (probe.geometry !== geometry) {
          probe.geometry = geometry;
          probe.geometrySince = performance.now();
        }
      }
      coordinates = [];
      return originalClearRect.apply(this, args);
    };
    probe.finish = () => {
      context.drawImage = originalDrawImage;
      context.clearRect = originalClearRect;
    };
    window.__MINE_GRAPH_STABLE_GEOMETRY__ = probe;
  });
  try {
    await page.waitForFunction(() => {
      const geometry = window.__MINE_GRAPH_STABLE_GEOMETRY__;
      if (!geometry) throw new Error("Graph route reloaded while waiting for the simulation to settle");
      const canvas = document.querySelector("[data-graph-view] canvas");
      const frame = canvas.toDataURL("image/png");
      const previous = window.__MINE_GRAPH_STABLE_FRAME__;
      if (!previous || previous.frame !== frame) {
        window.__MINE_GRAPH_STABLE_FRAME__ = { frame, since: performance.now() };
        return false;
      }
      return performance.now() - previous.since >= 500
        && geometry.geometry !== null && performance.now() - geometry.geometrySince >= 500;
    }, undefined, { polling: 100, timeout: 10_000 });
  } finally {
    await page.evaluate(() => window.__MINE_GRAPH_STABLE_GEOMETRY__?.finish());
  }
}

async function installCardHoverProbe(canvas, target) {
  // Trace the thumbnail's real clipping path, not its hover paint. The only
  // permitted pixel changes are a one-CSS-pixel stroke of that same path.
  // This catches enlargement, inner-image changes and changes to other nodes
  // without allowing an arbitrary percentage of the canvas to change.
  await canvas.evaluate((node, point) => {
    const context = node.getContext("2d");
    const mask = document.createElement("canvas");
    mask.width = node.width;
    mask.height = node.height;
    const maskContext = mask.getContext("2d");
    const colorProbe = document.createElement("span");
    colorProbe.className = "bg-chrome";
    colorProbe.style.outlineColor = "var(--component-fill-hover)";
    colorProbe.style.borderColor = "var(--border)";
    colorProbe.style.borderStyle = "solid";
    colorProbe.style.borderWidth = "1px";
    document.body.appendChild(colorProbe);
    // Every card carries a frame at rest, `--border`, and the pointer lights
    // it, `--component-fill-hover` (DESIGN_SYSTEM.md, «Карточка на графе»):
    // the rest frame on the same path is allowed, only the lit one counts.
    maskContext.strokeStyle = getComputedStyle(colorProbe).borderTopColor;
    const restColor = maskContext.strokeStyle;
    maskContext.strokeStyle = getComputedStyle(colorProbe).outlineColor;
    const expectedColor = maskContext.strokeStyle;
    colorProbe.remove();

    const originals = new Map();
    const replace = (name, wrapper) => {
      originals.set(name, context[name]);
      context[name] = wrapper(context[name]);
    };
    let commands = [];
    let thumbnailPath = null;
    const probe = { strokes: 0, errors: [], finish: null };
    replace("beginPath", (original) => function (...args) {
      commands = [];
      return original.apply(this, args);
    });
    for (const name of ["moveTo", "lineTo", "arcTo", "closePath"]) {
      replace(name, (original) => function (...args) {
        commands.push([name, ...args]);
        return original.apply(this, args);
      });
    }
    const pathKey = () => JSON.stringify([commands, context.getTransform().toString()]);
    replace("drawImage", (original) => function (image, ...args) {
      if (image instanceof HTMLImageElement && image.src.includes("/audit-2.svg")
        && this.isPointInPath(point.x, point.y)) {
        thumbnailPath = pathKey();
      }
      return original.call(this, image, ...args);
    });
    replace("stroke", (original) => function (...args) {
      if (thumbnailPath && pathKey() === thumbnailPath) {
        const transform = this.getTransform();
        const cssScale = Math.hypot(transform.a, transform.b) / devicePixelRatio;
        const lit = this.strokeStyle === expectedColor;
        if (Math.abs(this.lineWidth * cssScale - 1) > 1e-6
          || (!lit && this.strokeStyle !== restColor) || this.globalAlpha !== 1
          || this.getLineDash().length !== 0 || this.shadowBlur !== 0
          || this.shadowOffsetX !== 0 || this.shadowOffsetY !== 0
          || this.globalCompositeOperation !== "source-over") {
          if (probe.errors.length === 0) probe.errors.push({
            width: this.lineWidth * cssScale, color: this.strokeStyle, expectedColor, restColor,
            alpha: this.globalAlpha, dash: this.getLineDash(), shadow: this.shadowBlur,
            shadowX: this.shadowOffsetX, shadowY: this.shadowOffsetY,
            composition: this.globalCompositeOperation,
          });
        }
        maskContext.resetTransform();
        maskContext.clearRect(0, 0, mask.width, mask.height);
        maskContext.setTransform(transform);
        maskContext.lineWidth = 1 / cssScale;
        maskContext.strokeStyle = "white";
        maskContext.beginPath();
        for (const [name, ...values] of commands) maskContext[name](...values);
        maskContext.stroke();
        if (lit) probe.strokes += 1;
      }
      return original.apply(this, args);
    });
    probe.finish = () => {
      for (const [name, original] of originals) context[name] = original;
      return { strokes: probe.strokes, errors: probe.errors, mask: mask.toDataURL("image/png") };
    };
    window.__MINE_GRAPH_HOVER_PROBE__ = probe;
  }, target);
}

async function verifyCardHoverOutline(page) {
  const canvas = page.locator("[data-graph-view] canvas").first();
  await waitForGraphRest(page, canvas);
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Graph canvas has no bounding box for hover verification");
  const before = await canvasScreenshot(page);
  const target = findAuditCardPixel(before);
  if (!target) throw new Error("Could not locate the red audit thumbnail in graph pixels");
  await installCardHoverProbe(canvas, target);
  let probe;
  let after;
  try {
    await page.mouse.move(box.x + target.x, box.y + target.y);
    await page.waitForSelector("[data-graph-card-hover-preview]", { timeout: 800 });
    after = await canvasScreenshot(page);
  } finally {
    probe = await page.evaluate(() => window.__MINE_GRAPH_HOVER_PROBE__?.finish());
  }
  if (!probe) throw new Error("Graph route reloaded during hover verification");
  if (probe.strokes === 0 || probe.errors.length > 0) {
    throw new Error(`Card hover must outline its thumbnail path at 1px: ${JSON.stringify({
      strokes: probe.strokes, errors: probe.errors,
    })}`);
  }
  const mask = Buffer.from(probe.mask.split(",", 2)[1], "base64");
  const changed = changedPixels(before, after, mask);
  if (changed.ratio === 0 || changed.outsideOutline !== 0) {
    throw new Error(`Card hover changed outside its 1px outline: ${JSON.stringify(changed)}`);
  }
  await page.mouse.move(box.x + 8, box.y + 8);
  return changed.ratio;
}

function pixelAt(buffer, point) {
  const png = PNG.sync.read(buffer);
  const index = (png.width * point.y + point.x) << 2;
  return [...png.data.slice(index, index + 4)];
}

async function waitForStableCanvas(page) {
  // The hover fades over at most 150 ms; a frame unchanged for twice that
  // long has finished both the fade and the hover's own redraw.
  await page.evaluate(() => {
    delete window.__MINE_GRAPH_STABLE_FRAME__;
  });
  await page.waitForFunction(() => {
    const canvas = document.querySelector("[data-graph-view] canvas");
    const frame = canvas.toDataURL("image/png");
    const previous = window.__MINE_GRAPH_STABLE_FRAME__;
    if (!previous || previous.frame !== frame) {
      window.__MINE_GRAPH_STABLE_FRAME__ = { frame, since: performance.now() };
      return false;
    }
    return performance.now() - previous.since >= 300;
  }, undefined, { polling: 100, timeout: 5_000 });
}

// Waits until the canvas pixel at `point` is within `tolerance` of `wanted`
// on every channel; false when it never gets there.
async function waitForCanvasPixel(page, point, wanted, tolerance) {
  try {
    await page.waitForFunction(({ x, y, rgb, within }) => {
      const canvas = document.querySelector("[data-graph-view] canvas");
      const context = canvas?.getContext("2d");
      if (!context) return false;
      const pixel = context.getImageData(x, y, 1, 1).data;
      return rgb.every((channel, index) => Math.abs(pixel[index] - channel) <= within);
    }, { x: point.x, y: point.y, rgb: wanted, within: tolerance }, { polling: 50, timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

async function verifyCollectionHoverDimming(page) {
  // SPEC_GRAPH_VIEW.md, «Приглушение при наведении на коллекцию». The red
  // audit thumbnail is a Research card (GraphAuditRoute: card i is in
  // collection i % 6 and draws audit-(i % 6).svg). Resting on Design must dim
  // that pixel to the card drawn at the colour law's graph context share
  // (`GRAPH_CONTEXT_OPACITY`) over the canvas, once the hover intent engine
  // has answered; moving on to Research must leave it as it was; leaving
  // must bring it back. That card hover dims nothing is the zero-change check
  // of verifyCardHoverOutline.
  const canvas = page.locator("[data-graph-view] canvas").first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Graph canvas has no bounding box for collection hover");
  const before = await canvasScreenshot(page);
  const target = findAuditCardPixel(before);
  if (!target) throw new Error("Could not locate the red audit thumbnail for collection hover");
  const labels = await page.evaluate(() => window.__MINE_GRAPH_LABELS__ ?? {});
  const design = labels.Design;
  const research = labels.Research;
  if (!design || !research) {
    throw new Error(`Collection pills were not painted: ${JSON.stringify(labels)}`);
  }
  const expected = await page.evaluate(async () => {
    // The share comes from the colour law itself, served by the dev server,
    // not from what the graph happens to draw.
    const { GRAPH_CONTEXT_OPACITY } = await import("/src/lib/colorLaw.ts");
    const probe = document.createElement("span");
    document.body.appendChild(probe);
    probe.style.backgroundColor = "var(--background)";
    const background = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const pixel = document.createElement("canvas");
    pixel.width = 1;
    pixel.height = 1;
    const context = pixel.getContext("2d", { willReadFrequently: true });
    context.fillStyle = background;
    context.fillRect(0, 0, 1, 1);
    return { opacity: GRAPH_CONTEXT_OPACITY, canvas: [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)] };
  });
  const original = pixelAt(before, target);
  const dimmedTarget = original.slice(0, 3)
    .map((channel, index) => expected.opacity * channel + (1 - expected.opacity) * expected.canvas[index]);

  // The dimming waits for the engine's dwell (SPEC_CARD_STATES.md, С7.1),
  // so each step first waits for the pixel to arrive, then for the fade to end.
  await page.mouse.move(box.x + design.x, box.y + design.y);
  await waitForCanvasPixel(page, target, dimmedTarget, 4);
  await waitForStableCanvas(page);
  const dimmed = pixelAt(await canvasScreenshot(page), target);
  await page.mouse.move(box.x + research.x, box.y + research.y);
  await waitForCanvasPixel(page, target, original.slice(0, 3), 2);
  await waitForStableCanvas(page);
  const lit = pixelAt(await canvasScreenshot(page), target);
  await page.mouse.move(box.x + 8, box.y + 8);
  await waitForStableCanvas(page);
  const restored = pixelAt(await canvasScreenshot(page), target);

  const near = (actual, wanted, tolerance) => wanted
    .every((channel, index) => Math.abs(actual[index] - channel) <= tolerance);
  const report = { target, original, dimmed, dimmedTarget, lit, restored, opacity: expected.opacity };
  if (Math.abs(dimmed[0] - original[0]) < 20 || !near(dimmed, dimmedTarget, 4)) {
    throw new Error(`Resting on Design must dim a Research card to GRAPH_CONTEXT_OPACITY: ${JSON.stringify(report)}`);
  }
  if (!near(lit, original.slice(0, 3), 2)) {
    throw new Error(`Moving on to Research must leave its own card as it was: ${JSON.stringify(report)}`);
  }
  if (!near(restored, original.slice(0, 3), 2)) {
    throw new Error(`Leaving the collection must bring the graph back: ${JSON.stringify(report)}`);
  }
  return { opacity: Number(expected.opacity.toFixed(3)), original, dimmed, lit, restored };
}

async function waitForCanvasAtRest(page) {
  // The canvas stops redrawing once its engine has stopped and nothing else
  // asks for a frame: no frame for 600 ms is a layout at rest.
  await page.waitForFunction(() => {
    const frame = window.__MINE_GRAPH_FRAME__;
    const now = performance.now();
    if (frame.seen !== frame.count) {
      frame.seen = frame.count;
      frame.seenAt = now;
      return false;
    }
    return now - frame.seenAt >= 600;
  }, undefined, { polling: 100, timeout: 15_000 });
  return page.evaluate(() => {
    const { count, images, dashed } = window.__MINE_GRAPH_FRAME__;
    return { count, images: JSON.stringify(images), dashed };
  });
}

async function switchExtraLinks(page, shown) {
  const before = await page.evaluate(() => window.__MINE_GRAPH_FRAME__.count);
  await page.locator("[data-graph-audit-links]").click();
  await page.waitForFunction((wanted) => (
    window.__MINE_GRAPH_AUDIT__?.lastOptions?.include_wikilinks === wanted
  ), shown);
  await page.waitForFunction((count) => window.__MINE_GRAPH_FRAME__.count > count, before);
  const after = await waitForCanvasAtRest(page);
  return { ...after, frames: after.count - before };
}

async function verifyLinkSwitchKeepsLayout(page) {
  // SPEC_GRAPH_VIEW.md, «Панель графа», ГП4: switching the extra kinds of
  // link off and on takes their dashed lines away and brings them back, and
  // leaves every card and pill where it was. The new lines are drawn in a
  // frame or two; a restarted simulation would redraw for seconds and move
  // the pictures.
  const atRest = await waitForCanvasAtRest(page);
  if (atRest.dashed === 0) {
    throw new Error(`The audit graph drew no dashed lines to switch off: ${JSON.stringify(atRest)}`);
  }
  const off = await switchExtraLinks(page, false);
  const on = await switchExtraLinks(page, true);
  const report = {
    dashedAtRest: atRest.dashed,
    dashedOff: off.dashed,
    dashedOn: on.dashed,
    framesOff: off.frames,
    framesOn: on.frames,
  };
  if (off.dashed !== 0 || on.dashed === 0) {
    throw new Error(`Switching the extra links must take the dashed lines away and back: ${JSON.stringify(report)}`);
  }
  if (off.images !== atRest.images || on.images !== atRest.images) {
    throw new Error(`Switching the extra links moved the layout: ${JSON.stringify(report)}`);
  }
  if (off.frames > MAX_LINK_SWITCH_FRAMES || on.frames > MAX_LINK_SWITCH_FRAMES) {
    throw new Error(`Switching the extra links restarted the simulation: ${JSON.stringify(report)}`);
  }
  return report;
}

async function runTheme(browser, theme) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(() => {
    window.__MINE_GRAPH_LINK_PAINT__ = {
      curvedLinks: 0,
      dashedLinks: 0,
    };
    // Where each collection pill was last painted, in canvas CSS pixels: the
    // label is drawn at the pill's centre.
    window.__MINE_GRAPH_LABELS__ = {};
    // The graph canvas's latest frame: where each picture was drawn and how
    // many dashed line groups, and how many frames it has drawn in all.
    window.__MINE_GRAPH_FRAME__ = { count: 0, images: [], dashed: 0, seen: -1, seenAt: 0 };
    const onGraphCanvas = (context) => context.canvas instanceof HTMLCanvasElement
      && context.canvas.closest("[data-graph-view]") !== null;
    const originalClearRect = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (onGraphCanvas(this)) {
        const frame = window.__MINE_GRAPH_FRAME__;
        frame.count += 1;
        frame.images = [];
        frame.dashed = 0;
      }
      return originalClearRect.apply(this, args);
    };
    const originalFrameDrawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (image, ...args) {
      if (onGraphCanvas(this)) {
        const transform = this.getTransform();
        window.__MINE_GRAPH_FRAME__.images.push(
          [transform.e, transform.f, transform.a, ...args].map((value) => Number(value.toFixed(3))),
        );
      }
      return originalFrameDrawImage.call(this, image, ...args);
    };
    const originalFillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
      if (this.canvas instanceof HTMLCanvasElement && this.canvas.closest("[data-graph-view]")) {
        const transform = this.getTransform();
        window.__MINE_GRAPH_LABELS__[text] = {
          x: transform.e / devicePixelRatio,
          y: transform.f / devicePixelRatio,
        };
      }
      return originalFillText.call(this, text, ...args);
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
        if (onGraphCanvas(this)) window.__MINE_GRAPH_FRAME__.dashed += 1;
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
    ? await verifyCardHoverOutline(page)
    : null;
  const collectionHoverDimming = theme === "dark"
    ? await verifyCollectionHoverDimming(page)
    : null;
  const linkSwitch = theme === "dark"
    ? await verifyLinkSwitchKeepsLayout(page)
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
    collectionHoverDimming,
    linkSwitch,
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
