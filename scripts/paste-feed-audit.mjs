// ⌘V over the feed pastes, with real key presses in headless WebKit, the
// engine of Mine's window (SPEC_KEYBOARD.md, «Global»). ⌘V is the Edit menu's
// stock Paste. A tab page is a child webview, and the menu takes a ⌘ chord
// before such a page sees it (SPEC_EDITING.md, Л12): the page never gets the
// ⌘V keydown, only the Paste item's `paste:`, which WebKit turns into the
// page's `paste` event. A headless page is no child webview: it gets the
// keydown and then `paste:` itself. The audit plays the tab page by keeping
// the ⌘V keydown from the page's listeners, the first thing in the page, and
// leaves WebKit's `paste:` alone; then it plays a page that gets both, which
// must paste once. In each state of the feed one press reads the clipboard
// once; in a field, a menu, a dialog and over an open card it reads nothing.
// The full App runs on a Tauri mock. Starts and stops its own Vite.
import assert from "node:assert/strict";
import { webkit } from "playwright";
import { COLD_START_MS, startAuditVite } from "./audit-vite.mjs";

/** The Tauri bridge the App boots on, with every command it is asked for. */
function tauriMock() {
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
      body: kind === "note" ? "# Note\n\nText." : "", body_hash: `h${i}`,
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
    list_taxonomy_snapshot: {
      generation: 1,
      tags: [{ tag: "Inbox", count: blocks.length }, { tag: "Other", count: 3 }],
      channels: [], total_blocks: blocks.length,
      memberships: blocks.map((b) => ({ block_id: b.id, tag: "Inbox" })),
    },
    list_pending_thumb_upgrades: [],
    search_grid_blocks: { generation: 1, search_generation: 1, blocks, has_more: false, next_cursor: null, cursor_reset: false },
    begin_note_edit: find,
    get_block: find,
    end_note_edit: null,
    list_card_associations: (args) => ({ generation: 1, slug: args?.slug, groups: [] }),
    read_clipboard_payload: { kind: "text", text: "Pasted text" },
  };
  window.__clipboardReads = 0;
  let callback = 1;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    convertFileSrc: () => `${location.origin}/feed-scroll-audit/audit-0.svg`,
    transformCallback: (fn) => { const id = callback++; window[`_${id}`] = fn; return id; },
    unregisterCallback: () => {},
    invoke: async (command, args) => {
      if (command === "read_clipboard_payload") window.__clipboardReads += 1;
      const answer = answers[command];
      if (answer !== undefined) return typeof answer === "function" ? answer(args) : answer;
      if (command.startsWith("plugin:event|listen")) return callback++;
      return null;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
}

/** The tab page: the menu has the ⌘V keydown, the page only `paste:`. Its
 *  default stays, so WebKit still carries out `paste:` after it. */
function childWebview() {
  window.addEventListener("keydown", (event) => {
    if (event.metaKey && event.code === "KeyV") event.stopImmediatePropagation();
  }, true);
}

const vite = await startAuditVite();
let browser;
const failures = [];
try {
  browser = await webkit.launch({ headless: true });

  const fresh = async (child) => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(COLD_START_MS);
    page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
    if (child) await page.addInitScript(childWebview);
    await page.addInitScript(tauriMock);
    await page.goto(vite.origin);
    await page.getByText("Find elements").waitFor({ timeout: COLD_START_MS });
    await page.waitForTimeout(600);
    return page;
  };
  const settle = (page, ms = 300) => page.waitForTimeout(ms);
  const field = (page) => page.getByRole("textbox", { name: "Find or create collection" }).first();
  /** ArrowLeft from the left column's card goes into the sidebar (М1). */
  const intoSidebar = async (page) => {
    await page.keyboard.press("ArrowRight");
    await settle(page, 150);
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press("ArrowLeft");
      await settle(page, 150);
    }
  };
  /** One real ⌘V; the clipboard reads it caused. */
  const press = async (page) => {
    await page.evaluate(() => { window.__clipboardReads = 0; });
    await page.keyboard.press("Meta+v");
    await settle(page, 400);
    return page.evaluate(() => window.__clipboardReads);
  };
  const expectReads = async (page, label, expected) => {
    const reads = await press(page);
    if (reads === expected) console.log(`PASS: ${label}: ${reads} clipboard read`);
    else failures.push(`${label}: ${reads} clipboard reads, expected ${expected}`);
  };

  /** The states over the feed, each ending where ⌘V must paste. */
  const feedStates = [
    ["the feed as it opens", async () => {}],
    ["a card opened with a click, closed with Escape", async (page) => {
      await page.getByText("Card 3", { exact: true }).first().click();
      await settle(page, 1200);
      await page.keyboard.press("Escape");
      await settle(page, 900);
    }],
    ["a walk through the feed with the arrows", async (page) => {
      for (const key of ["ArrowRight", "ArrowDown", "ArrowRight", "ArrowUp"]) {
        await page.keyboard.press(key);
        await settle(page, 150);
      }
    }],
    ["ArrowLeft into the sidebar and ArrowRight back", async (page) => {
      await intoSidebar(page);
      await page.keyboard.press("ArrowRight");
      await settle(page);
    }],
    ["Escape from the sidebar", async (page) => {
      await intoSidebar(page);
      await page.keyboard.press("Escape");
      await settle(page);
    }],
    ["a row of the sidebar in the keyboard's focus", async (page) => {
      await intoSidebar(page);
    }],
    ["the sidebar's field typed in and left with Escape", async (page) => {
      await field(page).click();
      await page.keyboard.type("in");
      await settle(page);
      await page.keyboard.press("Escape");
      await settle(page, 150);
      await page.keyboard.press("Escape");
      await settle(page);
    }],
    ["the sidebar's field left with ArrowDown and ArrowRight", async (page) => {
      await field(page).click();
      await page.keyboard.type("in");
      await settle(page);
      await page.keyboard.press("ArrowDown");
      await settle(page, 150);
      await page.keyboard.press("ArrowRight");
      await settle(page);
    }],
    ["a card's context menu closed with Escape", async (page) => {
      await page.getByText("Card 5", { exact: true }).first().click({ button: "right" });
      await settle(page);
      await page.keyboard.press("Escape");
      await settle(page);
    }],
    ["the window left for another and back", async (page) => {
      const other = await browser.newPage();
      await other.bringToFront();
      await settle(other);
      await other.close();
      await page.bringToFront();
      await settle(page);
    }],
  ];

  /** The states where ⌘V stays native: the feed reads nothing. */
  const nativeStates = [
    ["the caret in the sidebar's field", async (page) => {
      await field(page).click();
      await settle(page);
    }],
    ["an open card", async (page) => {
      await page.getByText("Card 3", { exact: true }).first().click();
      await settle(page, 1200);
    }],
    ["a card's context menu open", async (page) => {
      await page.getByText("Card 5", { exact: true }).first().click({ button: "right" });
      await settle(page);
    }],
    ["the search overlay open", async (page) => {
      await page.keyboard.press("Meta+f");
      await settle(page, 700);
    }],
  ];

  for (const [label, reach] of feedStates) {
    const page = await fresh(true);
    await reach(page);
    await expectReads(page, `tab page, ${label}`, 1);
    await page.close();
  }
  for (const [label, reach] of nativeStates) {
    const page = await fresh(true);
    await reach(page);
    await expectReads(page, `tab page, ${label}`, 0);
    await page.close();
  }
  // A page that gets the keydown and then `paste:` still pastes once.
  {
    const page = await fresh(false);
    await expectReads(page, "a page that gets the ⌘V keydown too", 1);
    await page.close();
  }

  assert.deepEqual(failures, []);
  console.log("PASS: ⌘V over the feed pastes once in every state, and stays native elsewhere");
} finally {
  await browser?.close();
  await vite.close();
}
