// The two-finger swipe over an element that scrolls sideways, in headless
// WebKit, the engine of Mine's window (SPEC_NARROW_WINDOW.md, У17): a real
// article body, real layout, real hit testing and a real wheel, which the jsdom
// tests cannot see. It asks the same question the native recogniser asks and
// checks that the wheel scrolls the element the answer names. The recogniser
// itself runs only in the app: its orders are the Rust tests of swipe_gesture.rs.
// Starts and stops its own Vite.
import assert from "node:assert/strict";
import { webkit } from "playwright";
import { COLD_START_MS, startAuditVite } from "./audit-vite.mjs";

const ENTRY = "/swipe-scroller-audit-entry.js";
const PAGE = "/__swipe-scroller-audit";
const QUESTION = "__MINE_HORIZONTAL_SCROLLER_AT__";
/** A row of cells wider than any column the page can give the table. */
const WIDE_CELLS = Array.from({ length: 12 }, (_, index) => `колонка-с-длинным-названием-${index}`);
const BODY = [
  "Абзац над таблицами.",
  "",
  `| ${WIDE_CELLS.join(" | ")} |`,
  `| ${WIDE_CELLS.map(() => "---").join(" | ")} |`,
  `| ${WIDE_CELLS.join(" | ")} |`,
  "",
  "| Имя | Значение |",
  "| --- | --- |",
  "| а | б |",
  "",
  "```text",
  "x".repeat(600),
  "```",
].join("\n");

const STAND = `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { ArticleMarkdown } from '/src/components/reading/ArticleMarkdown.tsx';
  import { NoteEmbedLookups } from '/src/components/reading/NoteEmbed.tsx';
  import { answerSwipeQuestion } from '/src/lib/horizontalScroller.ts';
  import '/src/styles/global.css';
  window.__TAURI_INTERNALS__ = { invoke: async () => null };
  answerSwipeQuestion();
  const h = React.createElement;
  const lookups = new NoteEmbedLookups('Cards/Stand');
  const image = () => null;
  createRoot(document.getElementById('root')).render(
    h('div', { id: 'pane', 'data-detail-scroll': '', style: { position: 'fixed', inset: 0, overflowX: 'hidden', overflowY: 'auto', padding: 40 } },
      h('div', { style: { maxWidth: 680 } },
        h(ArticleMarkdown, { body: ${JSON.stringify(BODY)}, sourceSlug: 'Cards/Stand', vaultPath: '/vault', noteEmbeds: lookups, tasks: null, image, onOpenNote: () => undefined }),
        h('div', { id: 'clipped', style: { overflowX: 'hidden', height: 60 } }, h('div', { style: { width: 3000, height: 60 } }))),
      h('div', { style: { height: 2000 } })));
`;

const vite = await startAuditVite([{
  name: "swipe-scroller-audit",
  resolveId(id) { return id === ENTRY ? `\0${ENTRY}` : undefined; },
  load(id) { return id === `\0${ENTRY}` ? STAND : undefined; },
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (!req.url.startsWith(PAGE)) return next();
      res.setHeader("Content-Type", "text/html");
      res.end(await server.transformIndexHtml(req.url, `<html><body><div id="root"></div><script type="module" src="${ENTRY}"></script></body></html>`));
      return undefined;
    });
  },
}]);

let browser;
try {
  browser = await webkit.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${vite.origin}${PAGE}`, { timeout: COLD_START_MS });
  await page.waitForSelector("pre", { timeout: COLD_START_MS });
  const wide = page.locator("[data-article-table-scroll]").first();
  const fitting = page.locator("[data-article-table-scroll]").nth(1);
  const code = page.locator("pre").first();
  const clipped = page.locator("#clipped");

  /** The middle of `locator` on screen, after the mouse goes there. */
  const pointTo = async (locator) => {
    const box = await locator.boundingBox();
    assert(box, "the element stands on the page");
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(point.x, point.y);
    return point;
  };
  const answerAt = ({ x, y }) => page.evaluate(([name, px, py]) => window[name](px, py), [QUESTION, x, y]);
  const leftOf = (locator) => locator.evaluate((element) => element.scrollLeft);
  /** A wheel over the point; true when `locator` moved by the time it settles. */
  const wheelMoves = async (locator, deltaX) => {
    const before = await leftOf(locator);
    await page.mouse.wheel(deltaX, 0);
    await page.waitForTimeout(250);
    return (await leftOf(locator)) !== before;
  };

  const wideWidths = await wide.evaluate((element) => [element.scrollWidth, element.clientWidth]);
  assert(wideWidths[0] > wideWidths[1], `the wide table is wider than its block: ${wideWidths}`);
  const wideMiddle = await pointTo(wide);
  assert.equal(await answerAt(wideMiddle), true, "the wide table answers yes");
  assert(await wheelMoves(wide, 200), "a real wheel scrolls the wide table");
  assert.equal(await page.evaluate(() => document.querySelector("#pane").scrollLeft), 0, "its parent stays");
  console.log("PASS: a wide table answers yes and the wheel scrolls it");

  // To its end, and on: the same answer, with nothing left to move.
  await wide.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await page.waitForTimeout(100);
  assert.equal(await answerAt(wideMiddle), true, "the wide table at its end still answers yes");
  assert.equal(await wheelMoves(wide, 200), false, "at its end the wheel moves nothing");
  assert(await wheelMoves(wide, -200), "the wheel scrolls it back from its end");
  console.log("PASS: at its end the wide table still answers yes");

  const fittingWidths = await fitting.evaluate((element) => [element.scrollWidth, element.clientWidth]);
  assert.equal(fittingWidths[0], fittingWidths[1], `the second table fits: ${fittingWidths}`);
  assert.equal(await answerAt(await pointTo(fitting)), false, "a table that fits answers no");
  console.log("PASS: a table that fits answers no");

  await code.scrollIntoViewIfNeeded();
  const codeMiddle = await pointTo(code);
  assert.equal(await answerAt(codeMiddle), true, "a long code block answers yes");
  assert(await wheelMoves(code, 200), "a real wheel scrolls the code block");
  console.log("PASS: a long code block answers yes and the wheel scrolls it");

  const clippedWidths = await clipped.evaluate((element) => [element.scrollWidth, element.clientWidth]);
  assert(clippedWidths[0] > clippedWidths[1], `the clipped block has more to show: ${clippedWidths}`);
  await clipped.scrollIntoViewIfNeeded();
  assert.equal(await answerAt(await pointTo(clipped)), false, "overflow-x: hidden answers no");
  console.log("PASS: a wider element under overflow-x: hidden answers no");

  await page.evaluate(() => { document.querySelector("#pane").scrollTop = 0; });
  await page.waitForTimeout(100);
  const paragraph = page.getByText("Абзац над таблицами.");
  assert.equal(await answerAt(await pointTo(paragraph)), false, "the vertically scrolling pane answers no");
  console.log("PASS: a paragraph in a vertically scrolling pane answers no");

  // A cell inside it too. The first one: the table goes back to its start, where
  // that cell stands in the block's view.
  await wide.evaluate((element) => { element.scrollLeft = 0; });
  const cell = wide.locator("td").first();
  assert.equal(await answerAt(await pointTo(cell)), true, "a cell of the wide table answers yes");
  console.log("PASS: a cell inside the wide table answers yes");

  assert.deepEqual(errors, [], "the page raised no errors");
  await page.close();
} finally {
  await browser?.close();
  await vite.close();
}
console.log("Swipe over a scroller: all checks passed");
