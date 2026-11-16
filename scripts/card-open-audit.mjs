// The opening of a card in headless WebKit, the engine of Mine's window
// (SPEC_READING_MODE.md, Ч0.5, Ч0.6; AUDIT_PERFORMANCE.md, О1, О2): the stand
// `src/dev/CardOpenAuditRoute.tsx`, built for production and served by the
// check itself, holds one card of the feed with the start of an article of
// 100 KB and opens it as the app does, over a made-up backend that answers
// with the whole note. Measured from the press of the card, on a page loaded
// anew for every run, so that every opening is the first of its session:
//
// - the open card's parts of the build are loaded before the press (Ч0.6);
// - the whole article is in a frame no later than 100 ms after the press:
//   the first frame in which the card holds the note's whole text, in the
//   reading surface or in the editor, counted to the end of that frame's
//   drawing (Ч0.5).
//
// The stand opens the card's own part of the page: the feed, the top row and
// the page's other work at a press are not in it. The median of the runs is
// judged; every run is printed with the machine's load beside it, which
// stretches every time measured here.
//
// The limit of 100 ms is not held yet, and SPEC_READING_MODE.md names the
// exception and the decision it waits for (`KNOWN_EXCEEDANCE`), as the
// editor's check does for its own (scripts/editing-perf-audit.mjs): the check
// fails when the measure gets worse than the exception's ceiling or holds
// the limit again (the exception is then stale and goes).
import assert from "node:assert/strict";
import { loadavg } from "node:os";
import { PNG } from "pngjs";
import { webkit } from "playwright";
import { routeEntry, serveProductionPage } from "./audit-production-page.mjs";

const ROUTE = "/__card-open-audit";
const VIEWPORT = { width: 1440, height: 900 };
/** The size of the article the limit is given for (AUDIT_PERFORMANCE.md,
 *  раздел 3, «Открытие карточки»). */
const ARTICLE_BYTES = 100 * 1024;
/** From the press to the frame that holds the whole article, ms: an answer
 *  within it reads as immediate (the same source). */
const CONTENT_LIMIT_MS = 100;
/** Openings measured, each on a page of its own; the median is the third. */
const RUNS = 5;
/** The greatest median this check has measured, ms: 15.11.2026, five runs
 *  with the machine's load from 6.0 to 7.6; the other medians of that day
 *  were 213 ms (load 2.3 to 2.5) and 240 ms (load 9.2 to 9.8). */
const GREATEST_MEASURED_MS = 261;
/** How much worse than the greatest measure the opening may get: a third. */
const CEILING_SHARE = 1.3;
/** The ceiling is rounded to this many ms. */
const CEILING_STEP_MS = 10;
/**
 * The exception SPEC_READING_MODE.md names (Ч14, «Проверка открытия
 * карточки»). Its ceiling is the greatest measure times 1.3, rounded to
 * 10 ms: 340 ms. It catches an opening a third slower, and with it a part of
 * the build loaded at the press, which adds about 300 ms (React holds a
 * revealed Suspense boundary back that long). A measure above the greatest
 * one that is no regression raises `GREATEST_MEASURED_MS`, and the ceiling
 * follows by the same rule.
 */
const KNOWN_EXCEEDANCE = {
  ceilingMs: Math.round((GREATEST_MEASURED_MS * CEILING_SHARE) / CEILING_STEP_MS) * CEILING_STEP_MS,
  why: "the article of 100 KB is parsed once, then drawn and laid out whole before its first frame",
  waitsFor: "the second step of О1, drawing the article in parts (AUDIT_PERFORMANCE.md, О1; SPEC_READING_MODE.md, Ч0.5)",
};
/** How long a page may take to load the open card's parts ahead of the
 *  press: `DETAIL_PRELOAD_LATEST_MS` (DetailView.tsx) and as much again for
 *  the load itself. */
const PRELOAD_WAIT_MS = 2_000;
/** How long an opening may take before the run gives up. */
const OPEN_WAIT_MS = 10_000;

/** The article's pictures, one small picture for all of them. */
function picture() {
  const png = new PNG({ width: 4, height: 3 });
  png.data.fill(128);
  return PNG.sync.write(png);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function load() {
  return loadavg().map((value) => value.toFixed(1)).join(" ");
}

const PICTURE = picture();
const served = await serveProductionPage({
  name: "card-open-audit",
  route: ROUTE,
  entry: routeEntry({
    module: "/src/dev/CardOpenAuditRoute.tsx",
    name: "CardOpenAuditRoute",
    // The pictures of the article and their previews come from the check's
    // own server.
    assetAddress: (path) => `/media/${encodeURIComponent(path)}`,
  }),
  respond(url, response) {
    if (!url.pathname.startsWith("/media/")) return false;
    response.writeHead(200, { "Content-Type": "image/png" });
    response.end(PICTURE);
    return true;
  },
});

let browser;
try {
  browser = await webkit.launch({ headless: true });
  const runs = [];
  for (let run = 0; run < RUNS; run += 1) {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(served.url, { waitUntil: "load" });
    const card = page.locator("[data-card-open-target]");
    await card.waitFor();
    const preloaded = await page
      .waitForSelector("[data-card-open-loaded]", { timeout: PRELOAD_WAIT_MS })
      .then(() => true, () => false);
    await card.click();
    await page.waitForFunction(() => window.__cardOpen.done, null, { timeout: OPEN_WAIT_MS });
    const record = await page.evaluate(() => window.__cardOpen);
    await context.close();

    assert.deepEqual(errors, [], "the page raised no error");
    assert.deepEqual(record.unknown, [], "the stand's backend knows every command the open card asks");
    assert(record.bytes >= ARTICLE_BYTES, `the article is of ${ARTICLE_BYTES} bytes, got ${record.bytes}`);
    const whole = record.frames.find((frame) => frame.article || frame.editor);
    assert(whole, "a frame holds the whole article");
    const editor = record.frames.find((frame) => frame.editor);
    const longest = Math.max(...record.frames.map((frame, index) => frame.at - (record.frames[index - 1]?.at ?? 0)));
    runs.push({
      preloaded: preloaded && record.loadedBeforePress === true,
      contentMs: whole.drawn,
      surface: whole.editor ? "editor" : "article",
      editorMs: editor.drawn,
      longestFrameMs: longest,
      frames: record.frames.length,
    });
    const last = runs[runs.length - 1];
    console.log(
      `run ${run + 1}: whole article in a frame ${last.contentMs.toFixed(1)} ms after the press (${last.surface}), `
      + `editor ${last.editorMs.toFixed(1)} ms, longest frame ${last.longestFrameMs.toFixed(1)} ms of ${last.frames}, `
      + `parts loaded before the press: ${last.preloaded ? "yes" : "no"}; load ${load()}`,
    );
  }

  const contentMs = median(runs.map((run) => run.contentMs));
  console.log(
    `card open: whole article of ${ARTICLE_BYTES / 1024} KB in a frame, median ${contentMs.toFixed(1)} ms of ${RUNS} runs `
    + `(lowest ${Math.min(...runs.map((run) => run.contentMs)).toFixed(1)} ms), limit ${CONTENT_LIMIT_MS} ms; load ${load()}`,
  );
  assert(runs.every((run) => run.preloaded), "the open card's parts of the build are loaded before the first press (Ч0.6)");
  assert(
    contentMs > CONTENT_LIMIT_MS,
    `the whole article is in a frame within ${CONTENT_LIMIT_MS} ms of the press (${contentMs.toFixed(1)} ms): `
    + "the limit holds, the exception is stale; remove it here and in SPEC_READING_MODE.md",
  );
  assert(
    contentMs <= KNOWN_EXCEEDANCE.ceilingMs,
    `the whole article is in a frame within ${KNOWN_EXCEEDANCE.ceilingMs} ms of the press, the ceiling of the known exception, `
    + `got ${contentMs.toFixed(1)} ms`,
  );
  console.log(
    `known exception: ${contentMs.toFixed(1)} ms against the limit of ${CONTENT_LIMIT_MS} ms, under the ceiling of `
    + `${KNOWN_EXCEEDANCE.ceilingMs} ms; ${KNOWN_EXCEEDANCE.why}; waits for ${KNOWN_EXCEEDANCE.waitsFor}`,
  );
  console.log("card open audit passed");
} finally {
  await browser?.close();
  await served.close();
}
