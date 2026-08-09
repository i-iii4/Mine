#!/usr/bin/env node
import { chromium } from "playwright";

const DEFAULT_AUDIT_URL = "http://127.0.0.1:1420/__sidebar-reorder-audit";
const AUDIT_URL = process.env.MINE_SIDEBAR_REORDER_AUDIT_URL ?? DEFAULT_AUDIT_URL;
const VIEWPORT = { width: 1200, height: 900 };
/// One drag: press on row #2, travel down past three rows, release on row #5.
const DRAG_STEPS = 36;
const ROW_SELECTOR = "[data-sidebar-row][data-sidebar-row-key^='tag:']";
const OVERLAY_SELECTOR = "[data-sidebar-tag-drag-preview]";
const PREVIEW_SELECTOR = "[data-sidebar-thumbnail-hover-preview]";

const failures = [];
const notes = [];

function check(name, ok, detail) {
  const line = `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`;
  console.log(line);
  if (!ok) failures.push(name);
}

async function assertDevServerReady(url) {
  try {
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new Error(
      [
        `Sidebar reorder audit route is not reachable: ${url}`,
        "Start the dev app first, then rerun `bun run test:sidebar-reorder`.",
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

function readRowOrder(page) {
  return page.$$eval(ROW_SELECTOR, (rows) =>
    rows.map((row) => row.getAttribute("data-sidebar-row-key")));
}

function readRowState(page, rowKey) {
  return page.evaluate((key) => {
    const row = document.querySelector(`[data-sidebar-row-key="${key}"]`);
    if (!row) return null;
    const style = getComputedStyle(row);
    const rect = row.getBoundingClientRect();
    const matrix = style.transform === "none"
      ? { ty: 0 }
      : { ty: new DOMMatrixReadOnly(style.transform).m42 };
    return {
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      translateY: matrix.ty,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  }, rowKey);
}

async function main() {
  await assertDevServerReady(AUDIT_URL);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT });
  page.on("pageerror", (error) => {
    failures.push(`pageerror: ${error.message}`);
    console.error("PAGEERROR", error);
  });

  await page.goto(AUDIT_URL);
  await page.waitForSelector(ROW_SELECTOR);
  await waitForAnimationFrames(page, 4);

  const initialOrder = await readRowOrder(page);
  check("route renders the collection list", initialOrder.length >= 10,
    `${initialOrder.length} rows`);

  const sourceKey = initialOrder[1];
  const witnessKey = initialOrder[2];
  const sourceState = await readRowState(page, sourceKey);
  const rowHeight = sourceState.rect.height;
  const grabX = sourceState.rect.x + Math.min(80, sourceState.rect.width / 3);
  const grabY = sourceState.rect.y + rowHeight / 2;
  // Travel far enough to pass three rows plus the activation threshold.
  const travel = rowHeight * 3 + 14;

  // ── Grab ────────────────────────────────────────────────────────────────
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move(grabX, grabY + 12, { steps: 3 });
  await waitForAnimationFrames(page, 2);

  const overlay = await page.$(OVERLAY_SELECTOR);
  check("overlay appears once the drag activates", overlay !== null);

  if (overlay) {
    const overlayBox = await overlay.boundingBox();
    const widthDelta = Math.abs(overlayBox.width - sourceState.rect.width);
    const heightDelta = Math.abs(overlayBox.height - rowHeight);
    check("overlay matches the row's size", widthDelta <= 2 && heightDelta <= 2,
      `Δw=${widthDelta.toFixed(1)} Δh=${heightDelta.toFixed(1)}`);

    const media = await page.evaluate(() => {
      const thumbs = document.querySelectorAll(
        "[data-sidebar-tag-drag-preview] [data-sidebar-preview-thumbnail] img",
      );
      const first = thumbs[0];
      return {
        count: thumbs.length,
        firstLoaded: first instanceof HTMLImageElement
          ? first.complete && first.naturalWidth > 0
          : false,
      };
    });
    check("overlay carries the row's media", media.count > 0 && media.firstLoaded,
      `${media.count} thumbnails, first loaded=${media.firstLoaded}`);
  }

  const grabbedState = await readRowState(page, sourceKey);
  check("source row is a hole, not a ghost", grabbedState.opacity === "0",
    `opacity=${grabbedState.opacity}`);
  check("source row is inert while dragging", grabbedState.pointerEvents === "none",
    `pointer-events=${grabbedState.pointerEvents}`);

  const navCursor = await page.$eval("[data-sidebar-scroll]",
    (nav) => getComputedStyle(nav).cursor);
  check("list shows the closed hand during the gesture", navCursor === "grabbing",
    `cursor=${navCursor}`);

  // ── Travel: sample the witness row every step ───────────────────────────
  const witnessSamples = [];
  let previewSeen = false;
  for (let step = 1; step <= DRAG_STEPS; step += 1) {
    const y = grabY + 12 + (travel * step) / DRAG_STEPS;
    await page.mouse.move(grabX, y);
    await waitForAnimationFrames(page, 1);
    const witness = await readRowState(page, witnessKey);
    witnessSamples.push(witness.translateY);
    if (!previewSeen && (await page.$(PREVIEW_SELECTOR)) !== null) {
      previewSeen = true;
    }
  }
  check("no hover preview opens during the gesture", !previewSeen);

  // The witness row sits directly under the source: as the copy passes it, it
  // must glide up by one row height and stay there. The samples land inside the
  // 200ms transition, so intermediate values are expected — what must never
  // appear is a direction change (up → back → up), the oscillation this audit
  // exists to catch.
  let directionChanges = 0;
  let lastDirection = 0;
  for (let i = 1; i < witnessSamples.length; i += 1) {
    const diff = witnessSamples[i] - witnessSamples[i - 1];
    if (Math.abs(diff) < 0.5) continue; // settled or sub-pixel jitter
    const direction = Math.sign(diff);
    if (lastDirection !== 0 && direction !== lastDirection) directionChanges += 1;
    lastDirection = direction;
  }
  const witnessTravel = witnessSamples[witnessSamples.length - 1] - witnessSamples[0];
  check(
    "witness row glides one row height without reversing",
    directionChanges === 0 && Math.abs(Math.abs(witnessTravel) - rowHeight) <= 2,
    `direction changes: ${directionChanges}, travel ${witnessTravel.toFixed(1)}px vs row ${rowHeight.toFixed(1)}px`,
  );
  notes.push(`witness travel ${witnessTravel.toFixed(1)}px, ${witnessSamples.length} samples, ${directionChanges} reversals`);

  // ── Drop ────────────────────────────────────────────────────────────────
  // The hole must sit in the slot the *pointer* is in, measured on the
  // start-of-gesture grid — not the slot nearest the dragged row's centre.
  const finalPointerY = grabY + 12 + travel;
  const gridTop = sourceState.rect.y - rowHeight; // row above the source is index 0
  const expectedIndex = Math.min(
    initialOrder.length - 1,
    Math.max(0, Math.floor((finalPointerY - gridTop) / rowHeight)),
  );
  await page.mouse.up();
  await waitForAnimationFrames(page, 2);

  const orderAfterDrop = await readRowOrder(page);
  const targetIndex = orderAfterDrop.indexOf(sourceKey);
  check("hole lands in the slot under the pointer", targetIndex === expectedIndex,
    `expected index ${expectedIndex}, got ${targetIndex}`);

  await page.waitForSelector(OVERLAY_SELECTOR, { state: "detached", timeout: 800 })
    .then(() => check("overlay lands and leaves within the drop animation", true))
    .catch(() => check("overlay lands and leaves within the drop animation", false,
      "overlay still mounted after 800ms"));

  const settledState = await readRowState(page, sourceKey);
  check("row is visible again after the flight", settledState.opacity === "1",
    `opacity=${settledState.opacity}`);

  await page.waitForTimeout(350);
  const orderSettled = await readRowOrder(page);
  check("order holds steady after the drop (no snap-back)",
    JSON.stringify(orderSettled) === JSON.stringify(orderAfterDrop),
    `after: ${orderSettled[1]}…`);

  // ── Fast scrub: frame pacing under a violent gesture ────────────────────
  const scrubSourceKey = orderSettled[2];
  const scrubState = await readRowState(page, scrubSourceKey);
  const scrubX = scrubState.rect.x + 60;
  const scrubTop = scrubState.rect.y - 2 * rowHeight; // grid top for index math
  const scrubStartY = scrubState.rect.y + rowHeight / 2;
  await page.evaluate(() => {
    const samples = [];
    let last = performance.now();
    let running = true;
    const tick = (now) => {
      samples.push(now - last);
      last = now;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__MINE_FRAME_SAMPLES__ = {
      stop: () => { running = false; },
      samples,
    };
  });
  await page.mouse.move(scrubX, scrubStartY);
  await page.mouse.down();
  await page.mouse.move(scrubX, scrubStartY + 12, { steps: 2 });
  for (let pass = 0; pass < 3; pass += 1) {
    await page.mouse.move(scrubX, scrubStartY + rowHeight * 7, { steps: 4 });
    await page.mouse.move(scrubX, scrubStartY - rowHeight * 1.5, { steps: 4 });
  }
  // End in the middle of a slot: a pointer parked exactly on a slot boundary
  // makes the expected index ambiguous by construction.
  const scrubEndY = scrubStartY + rowHeight * 4;
  await page.mouse.move(scrubX, scrubEndY, { steps: 4 });
  await waitForAnimationFrames(page, 3);
  const frameStats = await page.evaluate(() => {
    const tracker = window.__MINE_FRAME_SAMPLES__;
    tracker.stop();
    const samples = tracker.samples.slice(1); // first delta spans setup
    const max = Math.max(...samples);
    const over100 = samples.filter((gap) => gap > 100).length;
    return { max, over100, count: samples.length };
  });
  check("fast scrub keeps frames flowing", frameStats.max <= 250 && frameStats.over100 <= 2,
    `max gap ${frameStats.max.toFixed(0)}ms, ${frameStats.over100} gaps >100ms of ${frameStats.count}`);
  notes.push(`fast-scrub frame gaps: max ${frameStats.max.toFixed(0)}ms over ${frameStats.count} frames`);

  const scrubExpected = Math.min(
    initialOrder.length - 1,
    Math.max(0, Math.floor((scrubEndY - scrubTop) / rowHeight)),
  );
  await page.mouse.up();
  await waitForAnimationFrames(page, 2);
  const orderAfterScrub = await readRowOrder(page);
  check("hole still tracks the pointer after a fast scrub",
    orderAfterScrub.indexOf(scrubSourceKey) === scrubExpected,
    `expected ${scrubExpected}, got ${orderAfterScrub.indexOf(scrubSourceKey)}`);

  // ── Escape cancels ──────────────────────────────────────────────────────
  const cancelSource = orderAfterScrub[3];
  const cancelState = await readRowState(page, cancelSource);
  await page.mouse.move(cancelState.rect.x + 60, cancelState.rect.y + cancelState.rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(cancelState.rect.x + 60,
    cancelState.rect.y + cancelState.rect.height / 2 + rowHeight * 2, { steps: 8 });
  await waitForAnimationFrames(page, 2);
  const overlayDuringCancel = await page.$(OVERLAY_SELECTOR);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await waitForAnimationFrames(page, 4);
  const orderAfterCancel = await readRowOrder(page);
  check("Escape cancels the gesture without reordering",
    overlayDuringCancel !== null
      && JSON.stringify(orderAfterCancel) === JSON.stringify(orderAfterScrub));

  for (const note of notes) console.log(`INFO ${note}`);

  await browser.close();
  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll sidebar reorder checks passed.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
