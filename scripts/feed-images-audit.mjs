#!/usr/bin/env node
// Pictures of the feed while it scrolls (SPEC_FEED_SCROLL_PERFORMANCE.md,
// «Проверка картинок при прокрутке»; AUDIT_FEED_IMAGES.md, разделы 5 и 11).
//
// What it measures: the share of pictures that stood in the visible part of
// the feed as a dark rectangle in at least one frame of a recording of the
// page, and the number of picture addresses the page asked the server for
// more than once in one pass forward.
//
// Why this way:
// - WebKit, because the app's page is WebKit's and the defect is its own: in
//   Chromium no picture is late on any build, so test:feed-scroll cannot see it.
// - A recording, not screenshots: a screenshot makes WebKit decode every
//   picture at once and shows a feed that the screen never showed.
// - Wheel events sent without waiting for the page: the engine's scrolling
//   thread moves the feed ahead of the page, as a trackpad does.
// - A ruler inside the feed's content tells every frame of the recording which
//   scroll position it shows, so the frame knows which picture slots are in it.
//
//   node scripts/feed-images-audit.mjs [--runs=N] [--scenarios=steady,flings,from-rest]
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { webkit } from "playwright";
import { PNG } from "pngjs";
import { routeEntry, serveProductionPage } from "./audit-production-page.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = join(root, "scripts/fixtures/feed-images");
const AUDIT_ROUTE = "/__feed-images-audit";
const COLD_START_MS = 120_000;

const VIEWPORT = { width: 1440, height: 900 };
const DEVICE_SCALE_FACTOR = 2;
/** The recording's frames per second (Playwright's video). */
const VIDEO_FPS = 25;
/** The ruler: one column of 4 px per bit of the position, in cells of 16 px. */
const RULER_BITS = 15;
const RULER_CELL_PX = 16;
const RULER_WIDTH_PX = 4 + RULER_BITS * 4;
/** The page's frame counter in the corner of the page. */
const COUNTER_BITS = 14;
/** A slot's sample darker than this is the card's surface, not a picture:
 *  the fixtures' darkest point is brighter than 100, the dark theme's card
 *  surface is under 45. */
const DARK_LUMA = 70;
/** No picture slot of the route is taller: the search over slots relies on it. */
const MAX_SLOT_HEIGHT_PX = 700;
/** Under this share of frames with a readable ruler the run does not judge:
 *  a machine loaded past its cores drops frames of the recording. */
const MIN_READABLE_FRAME_SHARE = 0.9;
const MAX_ATTEMPTS = 3;

/**
 * The scenarios and the share of dark pictures each may show. A threshold
 * stands midway between the worst run with the picture prepared on mount and
 * the best run without it, so the audit fails on the feed as it was before
 * 15.11.2026 and on the loss of the preparation. Measured on 15.11.2026 in
 * WebKit 26.4 at a machine load of 3 to 15 (SPEC_FEED_SCROLL_PERFORMANCE.md,
 * «Проверка картинок при прокрутке»), prepared against not prepared:
 *   steady     12–25 % in 16 runs   36–44 % in 11 runs
 *   flings     10–27 % in 17 runs   32–47 % in 10 runs
 *   from-rest   4–13 % in 16 runs   25–35 % in 10 runs
 * The 2 % of AUDIT_FEED_IMAGES.md, раздел 11, belongs to the variant that
 * keeps the cards' layers painted with an animation, which is not in use.
 */
const SCENARIOS = {
  steady: {
    title: "6 px/ms for 4 s",
    maxDarkShare: 0.30,
    minPictures: 400,
    run: (page) => wheel(page, 4000, () => 6),
  },
  flings: {
    title: "three flings from 14 px/ms",
    maxDarkShare: 0.30,
    minPictures: 300,
    run: (page) => wheel(page, 4500, (t) => 14 * Math.exp(-(t % 1500) / 450)),
  },
  "from-rest": {
    title: "six flicks from rest with a pause of 1.8 s",
    maxDarkShare: 0.19,
    minPictures: 200,
    run: async (page) => {
      for (let flick = 0; flick < 6; flick += 1) {
        await wheel(page, 700, (t) => 8 * Math.exp(-t / 300));
        await sleep(1800);
      }
    },
  },
};
/** A picture is asked for once in a pass forward. */
const MAX_REPEATED_ADDRESSES = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Scrolling ──────────────────────────────────────────────────────────────

/** One wheel event every 8 ms at `velocity(t)` px/ms, sent without waiting
 *  for the previous one's answer: waiting ties the cadence to the page's
 *  frames and delivers the scroll in bursts. */
async function wheel(page, durationMs, velocity) {
  const started = performance.now();
  let last = started;
  let carry = 0;
  const sent = [];
  for (;;) {
    const now = performance.now();
    const elapsed = now - started;
    if (elapsed >= durationMs) break;
    carry += velocity(elapsed) * (now - last);
    last = now;
    const delta = Math.trunc(carry);
    if (delta !== 0) {
      carry -= delta;
      sent.push(page.mouse.wheel(0, delta));
    }
    // Spin on the event loop: a sleeping timer is late on a loaded machine.
    while (performance.now() - now < 8) await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(sent);
}

// ─── The page side ──────────────────────────────────────────────────────────

/** Adds the ruler to the feed's content, the frame counter and the "probe is
 *  running" mark to the page, and a probe that records, in every frame of the
 *  page, which cards are mounted and which pictures have their bytes. */
function installProbe({ rulerBits, cell, counterBits }) {
  const layout = document.querySelector("[data-grid-layout]");
  const scroller = document.querySelector("[data-grid-scroll]");
  const height = layout.getBoundingClientRect().height;
  const ruler = document.createElement("div");
  ruler.style.cssText = `position:absolute;left:0;top:0;width:${4 + rulerBits * 4}px;height:${height}px;z-index:2147483000;pointer-events:none;background:#fff;`;
  for (let bit = 0; bit < rulerBits; bit += 1) {
    const period = cell * 2 ** bit;
    const column = document.createElement("div");
    column.style.cssText = `position:absolute;left:${4 + bit * 4}px;top:0;width:4px;height:100%;background:#000;`;
    if (bit <= 9) {
      column.style.backgroundImage = "linear-gradient(to bottom,#000 0,#000 50%,#fff 50%,#fff 100%)";
      column.style.backgroundSize = `4px ${2 * period}px`;
    } else {
      // A gradient of this period loses its edge to rounding: draw the segments.
      for (let y = period; y < height; y += 2 * period) {
        const segment = document.createElement("div");
        segment.style.cssText = `position:absolute;left:0;width:4px;top:${y}px;height:${Math.min(period, height - y)}px;background:#fff;`;
        column.appendChild(segment);
      }
    }
    ruler.appendChild(column);
  }
  layout.appendChild(ruler);

  const running = document.createElement("div");
  running.style.cssText = "position:fixed;right:0;top:0;width:16px;height:16px;background:#000;z-index:2147483001;pointer-events:none;";
  document.body.appendChild(running);

  const counter = document.createElement("div");
  counter.style.cssText = `position:fixed;right:24px;top:0;width:${8 + counterBits * 4}px;height:10px;background:#fff;z-index:2147483001;pointer-events:none;`;
  const counterCells = [];
  for (let bit = 0; bit < counterBits; bit += 1) {
    const counterCell = document.createElement("div");
    counterCell.style.cssText = `position:absolute;left:${4 + bit * 4}px;top:0;width:4px;height:10px;background:#000;`;
    counter.appendChild(counterCell);
    counterCells.push(counterCell);
  }
  document.body.appendChild(counter);
  let shown = 0;
  const showCount = (count) => {
    const changed = shown ^ count;
    for (let bit = 0; bit < counterBits; bit += 1) {
      if (changed & (1 << bit)) counterCells[bit].style.background = count & (1 << bit) ? "#fff" : "#000";
    }
    shown = count;
  };

  const probe = { frames: [], running: false, scroller, layout };
  window.__feedImagesProbe = probe;
  const tick = (now) => {
    if (!probe.running) return;
    const scrollerRect = scroller.getBoundingClientRect();
    // The layout's y shown at the scroller's first row.
    const from = scrollerRect.top - layout.getBoundingClientRect().top;
    const items = [];
    for (const item of layout.children) {
      if (!item.hasAttribute("data-feed-grid-item")) continue;
      const pictures = [];
      for (const img of item.querySelectorAll("img")) {
        pictures.push([img.getAttribute("src"), img.complete && img.naturalWidth > 0 ? 1 : 0]);
      }
      items.push([
        Number(item.getAttribute("data-feed-grid-item-index")),
        item.getAttribute("data-feed-grid-item-live") === "true" ? 1 : 0,
        pictures,
      ]);
    }
    probe.frames.push({ t: now, scrollTop: scroller.scrollTop, from, items });
    showCount(probe.frames.length & ((1 << counterBits) - 1));
    requestAnimationFrame(tick);
  };
  probe.start = () => {
    probe.frames = [];
    showCount(0);
    probe.running = true;
    running.style.background = "#fff";
    requestAnimationFrame(tick);
  };
  probe.stop = () => {
    probe.running = false;
    running.style.background = "#000";
    return probe.frames;
  };
  const scrollerRect = scroller.getBoundingClientRect();
  return {
    scroller: { x: scrollerRect.x, y: scrollerRect.y, width: scrollerRect.width, height: scrollerRect.height },
    layoutLeft: layout.getBoundingClientRect().x,
    maxScrollTop: scroller.scrollHeight - scroller.clientHeight,
  };
}

/** Every picture slot down to `untilScrollTop` in the layout's coordinates,
 *  read with the feed at rest. */
async function scanSlots(page, untilScrollTop) {
  const slots = new Map();
  const step = Math.round(VIEWPORT.height * 0.6);
  for (let top = 0; top <= untilScrollTop + step; top += step) {
    const found = await page.evaluate(async (scrollTop) => {
      const { scroller, layout } = window.__feedImagesProbe;
      scroller.scrollTop = scrollTop;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const layoutRect = layout.getBoundingClientRect();
      const out = [];
      for (const item of layout.children) {
        if (!item.hasAttribute("data-feed-grid-item")) continue;
        const index = Number(item.getAttribute("data-feed-grid-item-index"));
        for (const img of item.querySelectorAll("img")) {
          const rect = img.getBoundingClientRect();
          out.push({ index, src: img.getAttribute("src"), x: rect.x - layoutRect.x, y: rect.y - layoutRect.y, w: rect.width, h: rect.height });
        }
      }
      return out;
    }, Math.min(top, untilScrollTop));
    for (const slot of found) slots.set(slot.src, slot);
  }
  const all = [...slots.values()];
  const tallest = Math.max(0, ...all.map((slot) => slot.h));
  if (tallest > MAX_SLOT_HEIGHT_PX) throw new Error(`A picture slot is ${tallest} px tall, over the ${MAX_SLOT_HEIGHT_PX} px the audit searches by`);
  return all;
}

// ─── The recording ──────────────────────────────────────────────────────────

/** The ffmpeg Playwright records with: it decodes the recording's VP8 and
 *  writes PNG, so the machine's own ffmpeg is not needed. */
function playwrightFfmpeg() {
  const browsers = dirname(dirname(webkit.executablePath()));
  for (const folder of readdirSync(browsers).filter((name) => name.startsWith("ffmpeg-")).sort().reverse()) {
    const binary = readdirSync(join(browsers, folder)).find((name) => name.startsWith("ffmpeg"));
    if (binary) return join(browsers, folder, binary);
  }
  throw new Error(`Playwright's ffmpeg is not installed in ${browsers}: run \`bunx playwright install ffmpeg\``);
}

/** Calls `onFrame(luma, index)` with every frame of the recording as one
 *  byte of brightness per pixel. */
function readRecording(videoPath, folder, onFrame) {
  const made = spawnSync(playwrightFfmpeg(), ["-loglevel", "error", "-i", videoPath, "-pix_fmt", "gray", join(folder, "frame-%05d.png")], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`ffmpeg could not read the recording: ${made.stderr}`);
  const names = readdirSync(folder).filter((name) => name.startsWith("frame-")).sort();
  const luma = Buffer.alloc(VIEWPORT.width * VIEWPORT.height);
  names.forEach((name, index) => {
    const path = join(folder, name);
    const png = PNG.sync.read(readFileSync(path));
    rmSync(path);
    if (png.width !== VIEWPORT.width || png.height !== VIEWPORT.height) {
      throw new Error(`A frame of the recording is ${png.width}x${png.height}, not ${VIEWPORT.width}x${VIEWPORT.height}`);
    }
    // pngjs gives four bytes per pixel whatever the file holds: keep the first.
    for (let pixel = 0, byte = 0; pixel < luma.length; pixel += 1, byte += 4) luma[pixel] = png.data[byte];
    onFrame(luma, index);
  });
  return names.length;
}

/** What one frame of the recording shows: the page's frame it holds, the
 *  scroll position by the ruler, and each visible picture slot, dark or not. */
function analyseFrame(frame, setup, slotsByY) {
  const px = (x, y) => frame[Math.round(y) * VIEWPORT.width + Math.round(x)];
  const rulerX = setup.layoutLeft;
  const top = Math.ceil(setup.scroller.y);
  const bottom = Math.floor(setup.scroller.y + setup.scroller.height);
  const column = (bit) => rulerX + 4 + bit * 4 + 2;
  const guardOk = (y) => px(rulerX + 1.5, y) > 150;
  const bitAt = (bit, y) => (px(column(bit), y) > 128 ? 1 : 0);
  const code = (y) => {
    let value = 0;
    for (let bit = 0; bit < RULER_BITS; bit += 1) value |= bitAt(bit, y) << bit;
    return value;
  };

  let commit = 0;
  const counterLeft = VIEWPORT.width - 24 - (8 + COUNTER_BITS * 4);
  for (let bit = 0; bit < COUNTER_BITS; bit += 1) {
    if (px(counterLeft + 4 + bit * 4 + 2, 5) > 128) commit |= 1 << bit;
  }

  // The layout's y at the frame's row 0, read at three heights that must agree.
  const readings = [];
  for (const startRow of [top + 60, Math.round((top + bottom) / 2), bottom - 120]) {
    let edge = -1;
    for (let y = startRow; y < startRow + 2 * RULER_CELL_PX + 2; y += 1) {
      if (!guardOk(y) || !guardOk(y - 1)) continue;
      if (bitAt(0, y) !== bitAt(0, y - 1)) { edge = y; break; }
    }
    if (edge < 0) continue;
    const first = code(edge + RULER_CELL_PX / 2);
    const second = code(edge + RULER_CELL_PX + RULER_CELL_PX / 2);
    if (second !== first + 1 || !guardOk(edge + RULER_CELL_PX / 2)) continue;
    readings.push(first * RULER_CELL_PX - edge);
  }
  if (readings.length < 2) return { commit, unreadable: true };
  readings.sort((a, b) => a - b);
  if (readings[readings.length - 1] - readings[0] > 3) return { commit, unreadable: true };
  const rowZero = readings[Math.floor(readings.length / 2)];

  const viewFrom = rowZero + top;
  const viewTo = rowZero + bottom;
  const visible = [];
  let low = 0;
  let high = slotsByY.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (slotsByY[middle].y + MAX_SLOT_HEIGHT_PX < viewFrom) low = middle + 1;
    else high = middle;
  }
  for (let index = low; index < slotsByY.length && slotsByY[index].y <= viewTo; index += 1) {
    const slot = slotsByY[index];
    // The part of the slot on screen, 8 px in from its edges and clear of the ruler.
    const x0 = Math.max(setup.layoutLeft + slot.x + 8, rulerX + RULER_WIDTH_PX + 8);
    const x1 = setup.layoutLeft + slot.x + slot.w - 8;
    const y0 = Math.max(slot.y - rowZero + 8, top + 2);
    const y1 = Math.min(slot.y + slot.h - rowZero - 8, bottom - 2);
    if (x1 - x0 < 24 || y1 - y0 < 16) continue;
    let dark = 0;
    for (let ix = 0; ix < 3; ix += 1) {
      for (let iy = 0; iy < 3; iy += 1) {
        if (px(x0 + ((x1 - x0) * (ix + 0.5)) / 3, y0 + ((y1 - y0) * (iy + 0.5)) / 3) < DARK_LUMA) dark += 1;
      }
    }
    visible.push({
      src: slot.src,
      index: slot.index,
      dark: dark >= 7,
      whole: slot.y - rowZero >= top && slot.y + slot.h - rowZero <= bottom,
    });
  }
  return { commit, rowZero, visible };
}

// ─── One scenario ───────────────────────────────────────────────────────────

async function runScenario(browser, server, name) {
  const scenario = SCENARIOS[name];
  const folder = mkdtempSync(join(tmpdir(), "mine-feed-images-run-"));
  try {
    server.resetRequests();
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
      recordVideo: { dir: folder, size: VIEWPORT },
    });
    await context.addInitScript(() => { localStorage.setItem("theme", "dark"); });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text().slice(0, 200)); });
    page.on("pageerror", (error) => consoleErrors.push(String(error).slice(0, 200)));
    await page.goto(server.url, { timeout: COLD_START_MS });
    await page.waitForSelector("[data-feed-grid-item-live='true'] img", { timeout: COLD_START_MS });
    await page.waitForFunction(() => [...document.querySelectorAll("[data-feed-grid-item] img")].every((img) => img.complete), null, { timeout: 30_000 });
    await sleep(1200);
    const setup = await page.evaluate(installProbe, { rulerBits: RULER_BITS, cell: RULER_CELL_PX, counterBits: COUNTER_BITS });
    await page.mouse.move(Math.round(setup.scroller.x + setup.scroller.width / 2), Math.round(setup.scroller.y + setup.scroller.height / 2));
    await sleep(400);

    const loadBefore = loadavg()[0];
    await page.evaluate(() => window.__feedImagesProbe.start());
    await sleep(200);
    await scenario.run(page);
    await sleep(1500);
    const frames = await page.evaluate(() => window.__feedImagesProbe.stop());
    const loadAfter = loadavg()[0];
    // The pass forward ends here: the scan below scrolls back over the feed.
    const requests = server.requests();
    const reached = Math.max(0, ...frames.map((frame) => frame.scrollTop));
    await sleep(300);
    const slots = await scanSlots(page, Math.min(setup.maxScrollTop, reached + 2 * VIEWPORT.height));
    const video = page.video();
    await page.close();
    await context.close();
    const videoPath = await video.path();

    const slotsByY = slots.slice().sort((a, b) => a.y - b.y);
    const shownFrames = [];
    readRecording(videoPath, folder, (frame) => {
      // Only the frames recorded while the probe ran: its mark is white.
      if (frame[8 * VIEWPORT.width + (VIEWPORT.width - 8)] <= 128) return;
      shownFrames.push(analyseFrame(frame, setup, slotsByY));
    });

    /** The state the page's frame `commit` held the picture in. */
    const stateAt = (commit, src, itemIndex) => {
      const frame = frames[Math.min(frames.length - 1, commit)];
      if (!frame) return "unknown";
      const item = frame.items.find((entry) => entry[0] === itemIndex);
      if (!item) return "cardNotMounted";
      const picture = item[2].find((entry) => entry[0] === src);
      if (!item[1] || !picture) return "cardSkeleton";
      return picture[1] ? "bytesLoaded" : "bytesLoading";
    };
    const seen = new Set();
    const darkFramesBySrc = new Map();
    const darkByState = { bytesLoaded: 0, bytesLoading: 0, cardSkeleton: 0, cardNotMounted: 0, unknown: 0 };
    let readable = 0;
    let framesWithDark = 0;
    let darkWholeSlots = 0;
    for (const shown of shownFrames) {
      if (shown.unreadable) continue;
      readable += 1;
      let dark = 0;
      for (const slot of shown.visible) {
        seen.add(slot.src);
        if (!slot.dark) continue;
        dark += 1;
        if (slot.whole) darkWholeSlots += 1;
        darkFramesBySrc.set(slot.src, (darkFramesBySrc.get(slot.src) ?? 0) + 1);
        darkByState[stateAt(shown.commit, slot.src, slot.index)] += 1;
      }
      if (dark > 0) framesWithDark += 1;
    }
    const gaps = [];
    for (let index = 1; index < frames.length; index += 1) gaps.push(frames[index].t - frames[index - 1].t);
    const longestDark = Math.max(0, ...darkFramesBySrc.values());
    const repeated = [...requests.values()].filter((count) => count > 1).length;
    return {
      scenario: name,
      load: [Number(loadBefore.toFixed(1)), Number(loadAfter.toFixed(1))],
      recordedFrames: shownFrames.length,
      readableFrames: readable,
      readableShare: Number((readable / Math.max(1, shownFrames.length)).toFixed(3)),
      scrolledPx: Math.round(reached),
      pictures: seen.size,
      darkPictures: darkFramesBySrc.size,
      darkShare: Number((darkFramesBySrc.size / Math.max(1, seen.size)).toFixed(4)),
      framesWithDark,
      longestDarkMs: (longestDark * 1000) / VIDEO_FPS,
      darkWholeSlotFrames: darkWholeSlots,
      darkByState,
      pageFrames: gaps.length + 1,
      pageFramesOver25Ms: gaps.filter((gap) => gap > 25).length,
      pageFramesOver50Ms: gaps.filter((gap) => gap > 50).length,
      pictureRequests: [...requests.values()].reduce((sum, count) => sum + count, 0),
      pictureAddresses: requests.size,
      repeatedAddresses: repeated,
      consoleErrors: consoleErrors.slice(0, 5),
    };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** The scenario's result. It is measured again, up to MAX_ATTEMPTS times,
 *  while the recording is unreadable or a threshold is exceeded. Other work
 *  on the machine makes pictures later, never earlier, so the best attempt
 *  is the code's own. The addresses asked twice are judged the same way:
 *  without the preloader 62 runs of 63 had none and one had 2 of 325, while
 *  with the preloader every run had 97 to 344. */
async function judgeScenario(browser, server, name) {
  const scenario = SCENARIOS[name];
  const failures = [];
  const attempts = [];
  let result = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    result = await runScenario(browser, server, name);
    const readable = result.readableShare >= MIN_READABLE_FRAME_SHARE;
    attempts.push({ darkShare: result.darkShare, repeatedAddresses: result.repeatedAddresses, readableShare: result.readableShare, load: result.load });
    result.attempts = attempts;
    const within = result.darkShare <= scenario.maxDarkShare && result.repeatedAddresses <= MAX_REPEATED_ADDRESSES;
    if ((readable && within) || attempt === MAX_ATTEMPTS) break;
    console.error(readable
      ? `${name}: ${(result.darkShare * 100).toFixed(1)}% of pictures dark against ${(scenario.maxDarkShare * 100).toFixed(0)}%, ${result.repeatedAddresses} addresses asked twice (load ${result.load.join(" to ")}), measuring again`
      : `${name}: the ruler reads in ${(result.readableShare * 100).toFixed(0)}% of the recording's frames (load ${result.load.join(" to ")}), measuring again`);
  }
  if (result.readableShare < MIN_READABLE_FRAME_SHARE) {
    failures.push(`not judged: the ruler reads in ${(result.readableShare * 100).toFixed(0)}% of the recording's frames in ${MAX_ATTEMPTS} attempts, under ${MIN_READABLE_FRAME_SHARE * 100}%. The machine is too loaded to record the page (load ${result.load.join(" to ")})`);
    return { result, failures };
  }
  if (result.pictures < scenario.minPictures) {
    failures.push(`only ${result.pictures} pictures crossed the screen, under ${scenario.minPictures}: the feed did not scroll as the scenario asks`);
  }
  if (result.darkShare > scenario.maxDarkShare) {
    failures.push(`${result.darkPictures} of ${result.pictures} pictures (${(result.darkShare * 100).toFixed(1)}%) stood on screen as a dark rectangle, over ${(scenario.maxDarkShare * 100).toFixed(0)}%, in each of ${attempts.length} attempts (${attempts.map((attempt) => `${(attempt.darkShare * 100).toFixed(1)}%`).join(", ")})`);
  }
  if (result.repeatedAddresses > MAX_REPEATED_ADDRESSES) {
    failures.push(`${result.repeatedAddresses} of ${result.pictureAddresses} picture addresses were asked for more than once in the pass forward (${attempts.map((attempt) => attempt.repeatedAddresses).join(", ")} over ${attempts.length} attempts)`);
  }
  if (result.consoleErrors.length > 0) {
    failures.push(`the page reported errors: ${result.consoleErrors.join(" | ")}`);
  }
  return { result, failures };
}

// ─── The page ───────────────────────────────────────────────────────────────

/** The address the page loads a file from: a preview's is the audit server's
 *  own, and nothing serves a source. Written into the page as source. */
function previewAddress(path) {
  return path.startsWith("/thumbs/") ? path : null;
}

/** Builds the route for production and serves it together with the pictures:
 *  every `/thumbs/c<card>_<shape>.jpg` is the fixture of that shape, so each
 *  picture has its own address and the engine keeps each apart. Counts the
 *  requests for pictures by address. */
async function servePage() {
  const pictures = new Map();
  const picture = (pathname) => {
    const shape = /^\/thumbs\/c\d+_([a-z]+)(?:\.preview-\d+)?\.jpg$/.exec(pathname)?.[1];
    if (!shape) return null;
    if (!pictures.has(shape)) {
      const path = join(FIXTURES, `${shape}.jpg`);
      pictures.set(shape, existsSync(path) ? readFileSync(path) : null);
    }
    return pictures.get(shape);
  };
  let requests = new Map();
  const page = await serveProductionPage({
    name: "feed-images-audit",
    route: AUDIT_ROUTE,
    entry: routeEntry({ module: "/src/dev/FeedImagesAuditRoute.tsx", name: "FeedImagesAuditRoute", assetAddress: previewAddress }),
    respond(url, response) {
      if (!url.pathname.startsWith("/thumbs/")) return false;
      const body = picture(url.pathname);
      if (!body) {
        response.writeHead(404);
        response.end();
        return true;
      }
      const address = `${url.pathname}${url.search}`;
      requests.set(address, (requests.get(address) ?? 0) + 1);
      // The app's asset protocol sends no cache headers and WebKit holds such
      // an answer fresh without a term; over HTTP that takes the header.
      response.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": body.length, "Cache-Control": "max-age=31536000, immutable" });
      response.end(body);
      return true;
    },
  });
  return {
    url: page.url,
    resetRequests: () => { requests = new Map(); },
    requests: () => new Map(requests),
    close: page.close,
  };
}

function option(name, fallback) {
  const given = process.argv.slice(2).find((argument) => argument.startsWith(`--${name}=`));
  return given ? given.slice(name.length + 3) : fallback;
}

async function main() {
  const runs = Number(option("runs", "1"));
  const names = option("scenarios", Object.keys(SCENARIOS).join(",")).split(",");
  for (const name of names) if (!SCENARIOS[name]) throw new Error(`Unknown scenario ${name}: ${Object.keys(SCENARIOS).join(", ")}`);
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs takes a whole number from 1");

  const server = await servePage();
  let browser;
  try {
    browser = await webkit.launch({ headless: true });
    const results = [];
    const failures = [];
    for (let run = 1; run <= runs; run += 1) {
      for (const name of names) {
        const judged = await judgeScenario(browser, server, name);
        results.push({ run, ...judged.result });
        for (const failure of judged.failures) failures.push(`${name}${runs > 1 ? `, run ${run}` : ""}: ${failure}`);
      }
    }
    console.log(JSON.stringify({ engine: `WebKit ${browser.version()}`, viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE_FACTOR, results }, null, 2));
    for (const result of results) {
      console.log(`${result.scenario}: ${result.darkPictures} of ${result.pictures} pictures dark (${(result.darkShare * 100).toFixed(1)}%), `
        + `${result.repeatedAddresses} of ${result.pictureAddresses} addresses asked twice, ${result.pictureRequests} requests, `
        + `page frames over 25 ms ${result.pageFramesOver25Ms} of ${result.pageFrames}, over 50 ms ${result.pageFramesOver50Ms}, load ${result.load.join(" to ")}`);
    }
    if (failures.length > 0) {
      throw new Error(`Feed images audit failed:\n${failures.join("\n")}`);
    }
    console.log("\nAll feed images audit checks passed.");
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
