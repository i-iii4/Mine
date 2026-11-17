#!/usr/bin/env node
// The feed while its list grows and changes (SPEC_FEED_SCROLL_PERFORMANCE.md,
// «Проверка роста ленты»; AUDIT_PERFORMANCE.md, Л1, Л2 and Пр2).
//
// What it measures, on the real Grid built for production, in WebKit and in
// Chromium without a window:
// - how long the page works without a break when a page of 200 cards arrives
//   in a feed that holds 6 800 and when the row of one card arrives changed
//   in a feed that holds 7 000: the update of the list and the feed's work
//   on it, then the longest piece of work that follows it until the feed is
//   at rest again (the widths of the new cards' words arrive later);
// - the frames of a feed whose width changes by 8 px in every frame, 40
//   frames, with 1 000, 3 000 and 7 000 cards held. These are reported
//   without a limit: they decide whether the layout by parts is built
//   (AUDIT_PERFORMANCE.md, пункт 6).
//
//   node scripts/feed-growth-audit.mjs [--engines=webkit,chromium] [--parts=growth,width]
import { loadavg } from "node:os";
import { chromium, webkit } from "playwright";
import { routeEntry, serveProductionPage } from "./audit-production-page.mjs";

const AUDIT_ROUTE = "/__feed-growth-audit";
const COLD_START_MS = 120_000;
/** The window of the measurements of AUDIT_PERFORMANCE.md, Л1 and Л2. */
const VIEWPORT = { width: 1440, height: 1000 };
/** The cards the feed holds when it is measured, and a page of the feed. */
const LOADED_CARDS = 7000;
const PAGE_CARDS = 200;
/** Half a frame of 16.7 ms: the work of one change leaves the other half to
 *  the frame it lands in (AUDIT_PERFORMANCE.md, раздел 3). */
const MAX_WORK_MS = 8;
/** Each change is measured this many times; the median is judged. */
const REPEATS = 9;
/** A change over the limit is measured again, up to this many times: other
 *  work on the machine makes the page slower, never faster. */
const MAX_ATTEMPTS = 3;
const ENGINES = { webkit, chromium };

const WIDTH_CARDS = [1000, 3000, 7000];
const WIDTH_FRAMES = 40;
const WIDTH_STEP_PX = 8;
/** A frame of a 60 Hz screen: what a frame of a width change has to fit. */
const FRAME_MS = 16.7;
/** Frames of the page at rest read before the width changes: their median is
 *  the engine's own frame, 16.7 ms in WebKit and 8.3 ms in Chromium without
 *  a window on a 120 Hz screen. */
const RESTING_FRAMES = 30;

/** After how long a frame did not fit `FRAME_MS`: halfway from `FRAME_MS` to
 *  the next frame the engine can show after it. A frame that fits starts the
 *  next one up to a few milliseconds late or early (the page's callback is
 *  not called on the tick), and one that does not fit skips to the next tick:
 *  33.3 ms with a frame of 16.7 ms, 25 ms with a frame of 8.3 ms. */
function lateAfter(restingFrameMs) {
  const nextTick = restingFrameMs * (Math.floor(FRAME_MS / restingFrameMs + 0.05) + 1);
  return (FRAME_MS + nextTick) / 2;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const round = (value) => Number(value.toFixed(2));
const load = () => Number(loadavg()[0].toFixed(1));

// ─── The page side ──────────────────────────────────────────────────────────

/** Resolves once the feed is at rest: every card it holds has its exact
 *  height and is shown, over twelve frames in a row. With `sample`, resolves
 *  to the longest time the page worked without a break meanwhile: the
 *  longest wait of a message the page sends itself, one after another. A
 *  message is sent a quarter of a millisecond after the one before came:
 *  sent at once, they come by tens of thousands, and every one is an object
 *  the engine has to collect later, in the middle of what is measured. */
function feedAtRest(sample) {
  return new Promise((resolve) => {
    let longest = 0;
    let sampling = sample;
    if (sample) {
      const channel = new MessageChannel();
      let sent = performance.now();
      channel.port1.onmessage = () => {
        const came = performance.now();
        longest = Math.max(longest, came - sent);
        if (!sampling) {
          channel.port1.close();
          return;
        }
        while (performance.now() - came < 0.25);
        sent = performance.now();
        channel.port2.postMessage(0);
      };
      channel.port2.postMessage(0);
    }
    const route = document.querySelector("[data-feed-growth-audit-route]");
    let quiet = 0;
    const tick = () => {
      const count = Number(route.dataset.feedGrowthAuditBlockCount);
      const layout = window.__MINE_FEED_SCROLL_DEBUG__?.layout;
      const rested = count === 0 || Boolean(layout
        && layout.totalBlockCount === count
        && layout.measuredBlockCount === count
        && layout.committedEndIndex === count - 1
        && layout.viewportUnmeasuredCount === 0);
      quiet = rested ? quiet + 1 : 0;
      if (quiet < 12) {
        requestAnimationFrame(tick);
        return;
      }
      sampling = false;
      resolve(longest);
    };
    requestAnimationFrame(tick);
  });
}

/** The longest wait of the page's own message while nothing changes: what
 *  the measure reads on a page at rest. */
function restingWait(durationMs) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const started = performance.now();
    let sent = started;
    let longest = 0;
    channel.port1.onmessage = () => {
      const came = performance.now();
      longest = Math.max(longest, came - sent);
      if (came - started >= durationMs) {
        channel.port1.close();
        resolve(longest);
        return;
      }
      while (performance.now() - came < 0.25);
      sent = performance.now();
      channel.port2.postMessage(0);
    };
    channel.port2.postMessage(0);
  });
}

/** Resolves to the lengths of `frames` frames of the page: the time between
 *  two frames. With `stepPx`, narrows the feed by that much in each of them,
 *  so each frame holds the feed's work on one width. */
function frameLengths({ frames, stepPx }) {
  const route = document.querySelector("[data-feed-growth-audit-route]");
  const width = route.getBoundingClientRect().width;
  const stamps = [];
  return new Promise((resolve) => {
    const tick = () => {
      // The page's clock, not the frame's own time: WebKit rounds that one
      // to a millisecond.
      stamps.push(performance.now());
      if (stamps.length > frames) {
        route.style.width = "";
        resolve(stamps.slice(1).map((value, index) => value - stamps[index]));
        return;
      }
      if (stepPx) route.style.width = `${width - stamps.length * stepPx}px`;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// ─── Measures ───────────────────────────────────────────────────────────────

const rest = (page) => page.evaluate(feedAtRest, false);

/** One change, measured: the page's work on it and the longest work after. */
async function measureChange(page, change) {
  const measure = await page.evaluate(change.run, change.argument);
  const followUpMs = await page.evaluate(feedAtRest, true);
  return { listMs: measure.listMs, feedMs: measure.feedMs, workMs: measure.listMs + measure.feedMs, followUpMs };
}

/** The medians of `REPEATS` measures of `change`; `between` puts the feed
 *  back before the next one. */
async function measureRepeated(page, change, between) {
  const samples = [];
  const before = load();
  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    samples.push(await measureChange(page, change));
    if (between) {
      await between();
      await rest(page);
    }
  }
  const of = (key) => samples.map((sample) => sample[key]);
  return {
    workMs: round(median(of("workMs"))),
    worstWorkMs: round(Math.max(...of("workMs"))),
    listMs: round(median(of("listMs"))),
    feedMs: round(median(of("feedMs"))),
    followUpMs: round(median(of("followUpMs"))),
    worstFollowUpMs: round(Math.max(...of("followUpMs"))),
    load: [before, load()],
  };
}

/** A change's result, measured again while it is over the limit. */
async function judgeChange(page, name, change, between) {
  const attempts = [];
  let result = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    result = await measureRepeated(page, change, between);
    attempts.push({ workMs: result.workMs, followUpMs: result.followUpMs, load: result.load });
    if ((result.workMs <= MAX_WORK_MS && result.followUpMs <= MAX_WORK_MS) || attempt === MAX_ATTEMPTS) break;
    console.error(`${name}: ${result.workMs} ms of work, then ${result.followUpMs} ms, against ${MAX_WORK_MS} ms (load ${result.load.join(" to ")}), measuring again`);
  }
  const failures = [];
  if (result.workMs > MAX_WORK_MS) {
    failures.push(`the page worked ${result.workMs} ms without a break (the list ${result.listMs} ms, the feed ${result.feedMs} ms), over ${MAX_WORK_MS} ms, in each of ${attempts.length} attempts (${attempts.map((attempt) => attempt.workMs).join(", ")})`);
  }
  if (result.followUpMs > MAX_WORK_MS) {
    failures.push(`after the change the page worked ${result.followUpMs} ms without a break, over ${MAX_WORK_MS} ms, in each of ${attempts.length} attempts (${attempts.map((attempt) => attempt.followUpMs).join(", ")})`);
  }
  return { change: name, ...result, attempts, failures };
}

/** The feed scrolled down to where it asks for its next page: the lowest
 *  place, by steps of a window, where the cards left under the last card on
 *  the page are still as many as the feed's rule keeps ahead
 *  (`shouldPrefetchNextFeedPage`: 96, or four times the cards on the page).
 *  A page that arrives there adds no card to the page: what is measured is
 *  the feed's work on its list, not the drawing of new cards. */
async function scrollToWhereAPageIsAsked(page) {
  for (let windows = 3; ; windows += 1) {
    const top = await page.evaluate((above) => {
      const scroll = document.querySelector("[data-grid-scroll]");
      scroll.scrollTop = Math.max(0, scroll.scrollHeight - above * scroll.clientHeight);
      return scroll.scrollTop;
    }, windows);
    await rest(page);
    const ahead = await page.evaluate(() => {
      const debug = window.__MINE_FEED_SCROLL_DEBUG__;
      return {
        left: debug.layout.totalBlockCount - 1 - debug.layout.maxVisibleIndex,
        kept: Math.max(96, debug.mountedGridItems * 4),
      };
    });
    if (ahead.left >= ahead.kept || top === 0) return;
  }
}

/** A picture card on screen whose preview is not the shape its row declares:
 *  its height changes when the preview comes and when it goes. */
function pictureOnScreen() {
  const scroll = document.querySelector("[data-grid-scroll]");
  const box = scroll.getBoundingClientRect();
  for (const node of scroll.querySelectorAll('[data-feed-grid-item-live="true"]')) {
    const rect = node.getBoundingClientRect();
    const index = Number(node.getAttribute("data-feed-grid-item-index"));
    if (rect.top > box.top && rect.bottom < box.bottom && index % 20 < 10 && index % 5 !== 1) return index;
  }
  return null;
}

async function measureGrowth(page) {
  const results = [];
  await page.evaluate((count) => window.__MINE_FEED_GROWTH_AUDIT__.load(count), LOADED_CARDS - PAGE_CARDS);
  await rest(page);
  await scrollToWhereAPageIsAsked(page);
  const restingMs = round(await page.evaluate(restingWait, 400));

  results.push(await judgeChange(page, `a page of ${PAGE_CARDS} cards arrives, ${LOADED_CARDS - PAGE_CARDS} held`, {
    run: (count) => window.__MINE_FEED_GROWTH_AUDIT__.appendPage(count),
    argument: PAGE_CARDS,
  }, () => page.evaluate((count) => window.__MINE_FEED_GROWTH_AUDIT__.truncate(count), LOADED_CARDS - PAGE_CARDS)));

  await page.evaluate((count) => window.__MINE_FEED_GROWTH_AUDIT__.appendPage(count), PAGE_CARDS);
  await rest(page);
  const onScreen = await page.evaluate(pictureOnScreen);
  if (onScreen === null) throw new Error("No picture card stands on screen where the feed asks for its next page");
  const changeCard = { run: (index) => window.__MINE_FEED_GROWTH_AUDIT__.changeCard(index) };
  results.push(await judgeChange(page, `the row of a card on screen arrives changed, ${LOADED_CARDS} held`, { ...changeCard, argument: onScreen }));
  // Every card under the first one in its column moves with it.
  results.push(await judgeChange(page, `the row of the first card arrives changed, ${LOADED_CARDS} held`, { ...changeCard, argument: 0 }));
  return { restingMs, results };
}

async function measureWidth(page) {
  const results = [];
  for (const count of WIDTH_CARDS) {
    await page.evaluate((cards) => window.__MINE_FEED_GROWTH_AUDIT__.load(cards), count);
    await rest(page);
    await page.evaluate(() => { document.querySelector("[data-grid-scroll]").scrollTop = 0; });
    await rest(page);
    const before = load();
    const restingFrameMs = median(await page.evaluate(frameLengths, { frames: RESTING_FRAMES, stepPx: 0 }));
    const frames = await page.evaluate(frameLengths, { frames: WIDTH_FRAMES, stepPx: WIDTH_STEP_PX });
    await rest(page);
    const lateAfterMs = lateAfter(restingFrameMs);
    results.push({
      cards: count,
      medianFrameMs: round(median(frames)),
      longestFrameMs: round(Math.max(...frames)),
      framesOver: frames.filter((frame) => frame > lateAfterMs).length,
      frames: frames.length,
      restingFrameMs: round(restingFrameMs),
      lateAfterMs: round(lateAfterMs),
      frameMs: frames.map(round),
      load: [before, load()],
    });
  }
  return results;
}

// ─── The page ───────────────────────────────────────────────────────────────

/** The address the page loads a file from: the pictures of the feed scroll
 *  audit are the build's own. Written into the page as source. */
function pictureAddress(path) {
  return path.startsWith("/feed-scroll-audit/") ? path : null;
}

function option(name, fallback) {
  const given = process.argv.slice(2).find((argument) => argument.startsWith(`--${name}=`));
  return given ? given.slice(name.length + 3) : fallback;
}

async function runEngine(name, url, parts) {
  const browser = await ENGINES[name].launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const consoleErrors = [];
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: COLD_START_MS });
    await page.waitForFunction(() => Boolean(window.__MINE_FEED_GROWTH_AUDIT__), null, { timeout: COLD_START_MS });
    const result = {
      engine: `${name} ${browser.version()}`,
      // The page's clock: isolated from other origins, it reads to 0.02 ms
      // in WebKit, else to 1 ms.
      isolated: await page.evaluate(() => window.crossOriginIsolated === true),
    };
    if (parts.includes("growth")) Object.assign(result, await measureGrowth(page));
    if (parts.includes("width")) result.width = await measureWidth(page);
    result.pageErrors = consoleErrors.slice(0, 5);
    return result;
  } finally {
    await browser.close();
  }
}

async function main() {
  const engines = option("engines", Object.keys(ENGINES).join(",")).split(",");
  const parts = option("parts", "growth,width").split(",");
  for (const name of engines) if (!ENGINES[name]) throw new Error(`Unknown engine ${name}: ${Object.keys(ENGINES).join(", ")}`);
  for (const part of parts) if (part !== "growth" && part !== "width") throw new Error(`Unknown part ${part}: growth, width`);

  const server = await serveProductionPage({
    name: "feed-growth-audit",
    route: AUDIT_ROUTE,
    entry: routeEntry({ module: "/src/dev/FeedGrowthAuditRoute.tsx", name: "FeedGrowthAuditRoute", assetAddress: pictureAddress }),
    // Every answer isolates the page from other origins: the engine then
    // gives the page's clock its full precision, which WebKit otherwise
    // rounds to a millisecond.
    respond(_url, response) {
      response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      return false;
    },
  });
  try {
    const results = [];
    for (const name of engines) results.push(await runEngine(name, server.url, parts));
    console.log(JSON.stringify({ viewport: VIEWPORT, results }, null, 2));

    const failures = [];
    for (const result of results) {
      for (const change of result.results ?? []) {
        console.log(`${result.engine}: ${change.change}: ${change.workMs} ms of work (the list ${change.listMs}, the feed ${change.feedMs}; the longest of ${REPEATS} ${change.worstWorkMs}), `
          + `then at most ${change.followUpMs} ms (the longest ${change.worstFollowUpMs}; the page at rest ${result.restingMs}), load ${change.load.join(" to ")}`);
        for (const failure of change.failures) failures.push(`${result.engine}: ${change.change}: ${failure}`);
      }
      for (const width of result.width ?? []) {
        console.log(`${result.engine}: the width changes by ${WIDTH_STEP_PX} px a frame, ${width.cards} cards held: the median frame ${width.medianFrameMs} ms, `
          + `the longest ${width.longestFrameMs} ms, ${width.framesOver} of ${width.frames} frames did not fit ${FRAME_MS} ms `
          + `(the next one came after more than ${width.lateAfterMs} ms; a frame at rest ${width.restingFrameMs} ms), load ${width.load.join(" to ")}`);
      }
      if (result.pageErrors.length > 0) failures.push(`${result.engine}: the page reported errors: ${result.pageErrors.join(" | ")}`);
    }
    if (failures.length > 0) throw new Error(`Feed growth audit failed:\n${failures.join("\n")}`);
    console.log("\nAll feed growth audit checks passed.");
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
