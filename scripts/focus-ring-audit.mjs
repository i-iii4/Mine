// No browser focus ring anywhere in the main window, in headless WebKit, the
// engine of Mine's window (DESIGN_SYSTEM.md, «Focus», «Своя рамка фокуса у
// каждого элемента»). WebKit turns :focus-visible on for the focused element
// at any key press, a modifier alone included, even when the focus came from
// a press or a script; an element without a focus look of its own then shows
// the user agent's `outline-style: auto` ring. The audit plays the presses
// that leave focus on an element and the key after them, then focuses every
// focusable element after a key in each state of the window, and fails on any
// computed `auto` outline. The full App runs on a Tauri mock. Starts and
// stops its own Vite.
import assert from "node:assert/strict";
import { webkit } from "playwright";
import { COLD_START_MS, startAuditVite } from "./audit-vite.mjs";

const NOTE_BODY = [
  "# Note heading",
  "",
  "связанные_истории **Бустер депозита**",
  "",
  "A paragraph with a [link](https://example.com), a [[card-3]] wikilink and `code`.",
  "",
  "- [ ] task one",
  "- [x] task two",
  "",
  "| Key | Value |",
  "| --- | --- |",
  "| связанные_истории | **Бустер** |",
  "",
  "> [!note]- Folded callout",
  "> Inside the callout.",
  "",
  "```js",
  "const a = 1;",
  "```",
  "",
  "<details><summary>More</summary>Hidden text</details>",
  "",
  "![[card-3]]",
  "",
].join("\n");

/** The Tauri bridge the App boots on: a space of notes, links and pictures. */
function tauriMock(noteBody) {
  const card = (i) => {
    const kind = i % 3 === 1 ? "note" : i % 3 === 2 ? "link" : "image";
    return {
      id: i, slug: `card-${i}`, block_type: kind === "note" ? "article" : kind,
      card_kind: kind === "note" ? "article" : kind === "image" ? "media" : "link",
      title: `Card ${i}`, display_title: `Card ${i}`, fallback_label: `Card ${i}`,
      content_heading: null, description: null,
      url: kind === "link" ? `https://example.com/${i}` : null,
      media_file: kind === "image" ? `Media/picture-${i}.svg` : null,
      thumbnail: null, saved_at: "2026-10-18T14:23:24Z", source: null,
      width: kind === "image" ? 800 : null, height: kind === "image" ? 600 : null,
      author: kind === "link" ? "Author" : null, preview_text: `Some text of card ${i}`,
      first_image: null, media_urls: null, media_dimensions: null, preview_manifest: null,
      feed_playback: null, thumb_format: null, thumb_mtime: 0, related_notes: [], origin: null,
      index_warning: null, tags: ["Inbox"], collections: ["Inbox"],
      body: kind === "note" ? noteBody : "", body_hash: `h${i}`,
    };
  };
  const blocks = Array.from({ length: 24 }, (_, i) => card(i + 1));
  const find = (args) => blocks.find((b) => b.slug === args?.slug) ?? blocks[0];
  const answers = {
    get_vault_path: "/vault",
    open_vault: { indexed: blocks.length, derived_store_ready: true, thumbs_root: "/thumbs" },
    selection_generation: 1,
    list_known_vaults: ["/vault"],
    list_spaces: [],
    cloud_recommendation_state: { due: false },
    list_vault_conflict_paths: [],
    list_channel_previews: { generation: 1, previews: {} },
    space_onboarding_pending: false,
    list_grid_blocks: { generation: 1, blocks, total_blocks: blocks.length, has_more: false },
    list_taxonomy_snapshot: { generation: 1, tags: [{ tag: "Inbox", count: blocks.length }], channels: [], total_blocks: blocks.length, memberships: blocks.map((b) => ({ block_id: b.id, tag: "Inbox" })) },
    list_pending_thumb_upgrades: [],
    search_grid_blocks: { generation: 1, search_generation: 1, blocks, has_more: false, next_cursor: null, cursor_reset: false },
    begin_note_edit: find,
    get_block: find,
    end_note_edit: null,
    list_card_associations: (args) => ({ generation: 1, slug: args?.slug, groups: [{ kind: "site", label: "example.com", blocks: blocks.slice(1, 4) }] }),
  };
  let callback = 1;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    convertFileSrc: () => `${location.origin}/feed-scroll-audit/audit-0.svg`,
    transformCallback: (fn) => { const id = callback++; window[`_${id}`] = fn; return id; },
    unregisterCallback: () => {},
    invoke: async (command, args) => {
      const answer = answers[command];
      if (answer !== undefined) return typeof answer === "function" ? answer(args) : answer;
      if (command.startsWith("plugin:event|listen")) return callback++;
      return null;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
}

const FOCUSABLE = "a[href],button,input,textarea,select,[tabindex],[contenteditable]";

/** Every element whose computed outline is the user agent's ring. */
function ringed() {
  return [...document.querySelectorAll("*")]
    .filter((el) => getComputedStyle(el).outlineStyle === "auto")
    .map((el) => `${el.tagName.toLowerCase()}${[...el.attributes].filter((a) => a.name.startsWith("data-") || a.name === "role").map((a) => `[${a.name}]`).join("")}.${(el.getAttribute("class") ?? "").slice(0, 60)}`);
}

const vite = await startAuditVite();
let browser;
const failures = [];
try {
  browser = await webkit.launch({ headless: true });

  const fresh = async (view = "full") => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 760 }, colorScheme: "dark" });
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(COLD_START_MS);
    page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
    await page.addInitScript(tauriMock, NOTE_BODY);
    await page.addInitScript((cardView) => {
      try { localStorage.setItem("mine.detail.cardView", cardView); } catch { /* the default view */ }
    }, view);
    await page.goto(vite.origin);
    await page.getByText("Find elements").waitFor({ timeout: COLD_START_MS });
    await page.waitForTimeout(600);
    return page;
  };
  const settle = (page, ms = 400) => page.waitForTimeout(ms);
  const expectNoRing = async (page, label) => {
    const found = await page.evaluate(ringed);
    if (found.length) failures.push(`${label}: ${found.join(", ")}`);
    else console.log(`PASS: ${label}`);
  };
  /** Focuses each focusable element right after a key, as WebKit's
   *  heuristic needs, and records those that show the browser's ring. */
  const sweep = async (page, label) => {
    const count = await page.evaluate((sel) => document.querySelectorAll(sel).length, FOCUSABLE);
    const found = [];
    for (let index = 0; index < count; index += 1) {
      await page.keyboard.press("Shift");
      const hit = await page.evaluate(({ sel, index }) => {
        const el = document.querySelectorAll(sel)[index];
        if (!el || el.getClientRects().length === 0) return null;
        el.focus({ preventScroll: true });
        if (document.activeElement !== el || !el.matches(":focus-visible")) return null;
        const ring = getComputedStyle(el).outlineStyle === "auto";
        const name = `${el.tagName.toLowerCase()}${[...el.attributes].filter((a) => a.name.startsWith("data-") || a.name === "role").map((a) => `[${a.name}]`).join("")}.${(el.getAttribute("class") ?? "").slice(0, 60)}`;
        el.blur();
        return ring ? name : null;
      }, { sel: FOCUSABLE, index });
      if (hit && !found.includes(hit)) found.push(hit);
    }
    if (found.length) failures.push(`${label}, focus after a key: ${found.join(", ")}`);
    else console.log(`PASS: ${label}: ${count} focusable elements, no browser ring`);
  };

  // The presses that leave focus on an element, then a key.
  {
    const page = await fresh();
    for (const modifier of ["Shift", "Meta"]) {
      await page.getByText("Card 3", { exact: true }).first().click({ modifiers: [modifier] });
      await settle(page);
      await page.keyboard.press("ArrowRight");
      await settle(page, 150);
      await expectNoRing(page, `${modifier}-click on a feed card, then an arrow`);
      await page.keyboard.press("Escape");
      await settle(page);
    }
    await page.getByText("Card 5", { exact: true }).first().click({ button: "right" });
    await settle(page);
    await page.keyboard.press("Escape");
    await settle(page);
    await page.keyboard.press("ArrowRight");
    await settle(page, 150);
    await expectNoRing(page, "a card's context menu closed with Escape, then an arrow");
    await page.close();
  }
  {
    const page = await fresh();
    await page.getByText("Card 3", { exact: true }).first().click();
    await settle(page, 1200);
    await page.locator("[data-detail-scroll] img").first().click();
    await settle(page, 800);
    await page.keyboard.press("ArrowRight");
    await settle(page, 300);
    await expectNoRing(page, "the picture's preview opened with a press, then an arrow");
    await page.close();
  }

  // Every focusable element of each state.
  {
    const page = await fresh();
    await sweep(page, "the feed");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await settle(page, 1200);
    await sweep(page, "an open note");
    await page.locator("td").filter({ hasText: "Бустер" }).first().click();
    await settle(page);
    await sweep(page, "a table's cell in edit");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await settle(page, 900);
    await page.keyboard.press("Meta+f");
    await settle(page, 700);
    await sweep(page, "the search overlay");
    await page.close();
  }
  {
    const page = await fresh("peek");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await settle(page, 1200);
    await sweep(page, "an open note in Peek");
    await page.close();
  }

  assert.deepEqual(failures, []);
  console.log("PASS: no browser focus ring in the main window");
} finally {
  await browser?.close();
  await vite.close();
}
