// The search overlay as a person uses it, on the app's pages built for
// production (scripts/built-app-pages.mjs) in WebKit without a window
// (SPEC_SEARCH_OVERLAY.md, «Ответ на набранный текст» and «Прокрутка
// списка»). The keyboard types, erases and types again at a person's speed;
// the backend's stand-in answers each text with the cards whose names have a
// word starting with it, after a delay the audit sets per text. What is
// checked is what the person sees: the rows, their marks, the count, the
// date sections, and where the list stands once its scroll has stopped.
import { webkit } from "playwright";
import { PNG } from "pngjs";
import { installBackend, painted, spaceCards } from "./app-backend-stand-in.mjs";
import { PAGES, serveBuiltApp } from "./built-app-pages.mjs";

const VIEWPORT = { width: 1200, height: 800 };
/** A person's typing: about eight keys a second. */
const KEY_MS = 120;
/** Backspace held down: the key repeat of macOS at its default rate. */
const REPEAT_MS = 35;
/** A row thumbnail comes from the app's cache a moment after it is asked. */
const THUMB_MS = 120;

const thumb = (() => {
  const png = new PNG({ width: 64, height: 64 });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([90, 120, 160, 255], i);
  return PNG.sync.write(png);
})();

/** The space: names like the person's, saved over the year, so a search's
 *  answer, in the order of relevance, is not in the order of dates. */
function cards() {
  const named = ["MEK.txt", "mech commission", "meanswhile material", "MetalUI soft hardware",
    "metallic paint", "Medal of honor", "Melody", "meta notes", "method guide"];
  const words = ["memo", "mesh", "metro", "melon", "merit", "meadow"];
  return spaceCards({ count: 240 }).map((card, index) => {
    const name = named[index] ?? `${words[index % words.length]} ${index}`;
    const month = String((index * 5) % 10 + 1).padStart(2, "0");
    return { ...card, slug: name, title: name, display_title: name, fallback_label: name,
      saved_at: `2026-${month}-${String(index % 27 + 1).padStart(2, "0")}T10:00:00Z` };
  });
}

/** In the page before its scripts: the search of the backend's stand-in. A
 *  text of one character finds names with a word starting with it, newest
 *  first; a longer text finds the same way, in the order of the space. The
 *  recent cards are the newest twenty. `window.searchDelay(text)` delays an
 *  answer; `window.supersedeNext` stops the next request of that text as
 *  superseded. */
function installSearch() {
  const wrap = () => {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || internals.searchWrapped) return;
    internals.searchWrapped = true;
    const original = internals.invoke;
    const newest = (blocks) => [...blocks].sort((a, b) => b.saved_at.localeCompare(a.saved_at));
    internals.invoke = async (command, args) => {
      if (command === "list_grid_blocks" && args?.reason === "search") {
        window.__auditCommands.push({ command, args, at: performance.now() });
        const blocks = newest(window.__auditState.cards).slice(0, args.limit ?? 20);
        return { generation: 1, blocks, total_blocks: blocks.length, has_more: false };
      }
      if (command !== "search_grid_blocks") return original(command, args);
      window.__auditCommands.push({ command, args, at: performance.now() });
      const text = args.query.trim().toLowerCase();
      let blocks = [];
      for (const card of window.__auditState.cards) {
        const lower = card.slug.toLowerCase();
        const word = lower.split(/[^\p{L}\p{N}]+/u).find((part) => part.startsWith(text));
        if (!word) continue;
        const start = lower.indexOf(word);
        blocks.push({ ...card, search_match: { field: "title", kind: "prefix", excerpt: card.slug,
          ranges: [{ start, end: start + text.length }], score: 100, explanation: null } });
      }
      if (Array.from(text).length === 1) blocks = newest(blocks);
      await new Promise((resolve) => setTimeout(resolve, window.searchDelay?.(text) ?? 20));
      if (window.supersedeNext === text) {
        window.supersedeNext = null;
        throw { kind: "search_superseded" };
      }
      return { generation: 1, search_generation: 1, blocks: blocks.slice(0, 200),
        has_more: blocks.length > 200, next_cursor: null, cursor_reset: false };
    };
  };
  wrap();
  document.addEventListener("DOMContentLoaded", wrap);
}

const failures = [];
function check(ok, label, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(label);
}

const app = await serveBuiltApp({
  name: "search-overlay-audit",
  respond(url, response) {
    if (url.pathname !== "/__asset") return false;
    setTimeout(() => {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(thumb);
    }, THUMB_MS);
    return true;
  },
});

let browser;
try {
  browser = await webkit.launch({ headless: true });
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(installBackend, { cards: cards(), storage: { "mine.motion": "off", theme: "light" } });
  await page.addInitScript(installSearch);
  await page.goto(`${app.origin}${PAGES.tab}`);
  await page.waitForSelector("[data-block-slug]", { timeout: 60_000 });
  await painted(page, 4);
  // ⌘F: the native menu's Find Elements.
  await page.evaluate(() => window.__auditFire("surface-search-shortcut", "main"));
  const field = page.getByPlaceholder("Search elements…");
  await field.waitFor();
  await page.waitForSelector("[data-search-overlay-recent-label]");

  /** What the person sees in the overlay. */
  const seen = () => page.evaluate(() => {
    const list = document.getElementById("search-overlay-listbox");
    return {
      field: document.querySelector('[role="combobox"]').value,
      sections: [...list.querySelectorAll("[data-search-overlay-recent-label]")].map((label) => label.textContent),
      rows: [...list.querySelectorAll('[role="option"]')].length,
      firstRows: [...list.querySelectorAll("[data-card-row-name]")].slice(0, 4).map((name) => name.textContent),
      marks: [...new Set([...list.querySelectorAll("[data-card-row-name] mark")].map((mark) => mark.textContent))],
      unmarked: [...list.querySelectorAll('[role="option"]')]
        .filter((row) => !row.querySelector("[data-card-row-name] mark")).length,
      count: document.querySelector("[data-search-overlay-result-count]")?.textContent ?? null,
      error: document.querySelector("[data-search-overlay-error]") !== null,
    };
  });
  /** The list answers the text in the field: every row and only the rows of
   *  its answer, each marked over the whole text, no date sections. */
  function answersField(state) {
    const text = state.field.trim().toLowerCase();
    return state.sections.length === 0
      && state.unmarked === 0
      && state.marks.every((mark) => mark.toLowerCase() === text)
      && state.count?.replace("+", "") === String(state.rows)
      && !state.error;
  }
  const describe = (state) => JSON.stringify({ ...state, sections: state.sections.slice(0, 6) });
  async function type(text, gap = KEY_MS) {
    for (const key of text) {
      await page.keyboard.type(key);
      await page.waitForTimeout(gap);
    }
  }
  async function erase(count, gap) {
    for (let i = 0; i < count; i += 1) {
      await page.keyboard.press("Backspace");
      await page.waitForTimeout(gap);
    }
  }
  const settle = async () => {
    await page.waitForTimeout(500);
    await painted(page, 2);
  };

  // 1. The person types «me», holds Backspace down to the empty field and
  // types «metal».
  await type("me");
  await settle();
  let state = await seen();
  check(answersField(state) && state.marks[0]?.toLowerCase() === "me", "«me» shows its answer", describe(state));
  await erase(2, REPEAT_MS);
  await type("metal");
  await settle();
  state = await seen();
  check(answersField(state) && state.field === "metal", "«me» erased at once and «metal» typed: the list answers «metal»", describe(state));

  // 2. Erased to «me» key by key and «metal» typed again.
  await erase(3, 90);
  await settle();
  state = await seen();
  check(answersField(state) && state.field === "me", "erased to «me»: the list answers «me»", describe(state));
  await type("tal");
  await settle();
  state = await seen();
  check(answersField(state) && state.field === "metal", "«metal» typed again: the list answers «metal»", describe(state));

  // 3. Answers to the shorter texts come back after the answer to the
  // longer one; the current request is stopped once as superseded.
  await erase(5, REPEAT_MS);
  await settle();
  await page.evaluate(() => {
    window.searchDelay = (text) => ({ m: 500, me: 400, met: 250, meta: 120 })[text] ?? 0;
    window.supersedeNext = "metal";
  });
  await type("metal");
  await page.waitForTimeout(900);
  await painted(page, 2);
  state = await seen();
  check(answersField(state) && state.field === "metal",
    "late answers to shorter texts and a superseded «metal»: the list answers «metal», no error", describe(state));
  await page.evaluate(() => { window.searchDelay = null; });

  // 4. Scrolled with the wheel's momentum: deltas that die down frame by
  // frame. The hand rests at the list's bottom edge, over a row the edge
  // cuts, and moves a pixel as it leaves the trackpad. Once stopped, the list
  // stays where it stopped. A new opening: the list holds this answer only.
  await page.keyboard.press("Escape");
  await page.waitForSelector("#search-overlay-listbox", { state: "detached" });
  await page.evaluate(() => window.__auditFire("surface-search-shortcut", "main"));
  await field.waitFor();
  await field.fill("");
  await settle();
  await type("me");
  await settle();
  const list = page.locator("#search-overlay-listbox");
  const box = await list.boundingBox();
  const restAt = { x: box.x + 220, y: box.y + box.height - 3 };
  await page.mouse.move(restAt.x, restAt.y - 40);
  await page.mouse.move(restAt.x, restAt.y);
  async function momentum() {
    for (let delta = 90; delta >= 1; delta *= 0.86) {
      await page.mouse.wheel(0, delta);
      await page.waitForTimeout(16);
    }
    // The page's own work after the last event (the hover WebKit updates
    // once a scroll ends) is over.
    await page.waitForTimeout(300);
    return list.evaluate((element) => element.scrollTop);
  }
  async function samplesAfter(act) {
    await act();
    const samples = [];
    for (let i = 0; i < 6; i += 1) {
      await page.waitForTimeout(100);
      samples.push(await list.evaluate((element) => element.scrollTop));
    }
    return samples;
  }
  let stopped = await momentum();
  let samples = await samplesAfter(() => page.mouse.move(restAt.x + 1, restAt.y + 1));
  check(stopped > 0 && samples.every((top) => top === stopped),
    "the list stays where the wheel's momentum stopped it, the hand moving a pixel",
    `stopped at ${stopped}, then ${samples.join(", ")}`);

  // Stopped again with the hand still; the space changes and the answer is
  // read again in silence (vault-refreshed): the list keeps its place.
  stopped = await momentum();
  samples = await samplesAfter(() => page.evaluate(() => window.dispatchEvent(new Event("vault-refreshed"))));
  check(samples.every((top) => top === stopped),
    "a silent refresh after the momentum stopped leaves the list where it stands",
    `stopped at ${stopped}, then ${samples.join(", ")}`);

  // The arrows bring the row they move to into view.
  for (let i = 0; i < 25; i += 1) await page.keyboard.press("ArrowDown");
  await painted(page, 2);
  const inView = await page.evaluate(() => {
    const frame = document.getElementById("search-overlay-listbox").getBoundingClientRect();
    const row = document.querySelector('[role="option"][aria-selected="true"]').getBoundingClientRect();
    return row.top >= frame.top && row.bottom <= frame.bottom;
  });
  check(inView, "the arrows scroll to the row they moved to");

  check(errors.length === 0, "no page errors", errors.join("; "));
} finally {
  await browser?.close();
  await app.close();
}
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
