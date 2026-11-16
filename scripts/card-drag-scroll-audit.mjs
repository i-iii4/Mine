// A card dragged to the feed's edge leaves the feed where it is, in headless
// WebKit, the engine of Mine's window (SPEC_FRONTEND.md, «Лента не
// прокручивается под перетаскиванием карточки», decision of 15.11.2026).
// WebKit itself scrolls the box a press began in while the held pointer
// stands near or past its edge; a card's press holds that off. The sidebar's
// list still scrolls near its edges under a card, as the drag library does
// (`autoScroll` in App.tsx), and a click still gives the card the focus. Real
// pointer presses and moves over the full App on a Tauri mock. Starts and
// stops its own Vite.
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
  const blocks = Array.from({ length: 90 }, (_, i) => card(i + 1));
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
      // More collections than the sidebar's list shows, so the list scrolls.
      tags: Array.from({ length: 40 }, (_, i) => ({ tag: `Collection ${i}`, count: 3 })),
      channels: Array.from({ length: 40 }, (_, i) => ({
        tag: `Collection ${i}`, description: null, color: null, icon: null,
        position: i, created_at: "2026-10-18T14:23:24Z", block_count: 3,
      })), total_blocks: blocks.length,
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


/** How long the pointer is held at an edge: WebKit's own scroll of a pressed
 *  box runs in that time by hundreds of pixels (measured 15.11.2026). */
const HOLD_MS = 1000;

const vite = await startAuditVite();
let browser;
const failures = [];
const check = (ok, label) => {
  if (ok) console.log(`PASS: ${label}`);
  else failures.push(label);
};
try {
  browser = await webkit.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(COLD_START_MS);
  page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  await page.addInitScript(tauriMock);
  await page.goto(vite.origin);
  await page.getByText("Find elements").waitFor({ timeout: COLD_START_MS });
  await page.waitForTimeout(800);

  /** The feed's scroll box: the scrolling ancestor of its cards. */
  const scrolls = () => page.evaluate(() => {
    const card = document.querySelector("[data-block-slug]");
    let feed = card?.parentElement ?? null;
    while (feed && !(feed.scrollHeight > feed.clientHeight && getComputedStyle(feed).overflowY !== "visible")) {
      feed = feed.parentElement;
    }
    return {
      feed: Math.round(feed?.scrollTop ?? -1),
      sidebar: Math.round(document.querySelector("[data-sidebar-scroll]")?.scrollTop ?? -1),
    };
  });
  const setFeedScroll = (top) => page.evaluate((value) => {
    const card = document.querySelector("[data-block-slug]");
    let feed = card?.parentElement ?? null;
    while (feed && !(feed.scrollHeight > feed.clientHeight && getComputedStyle(feed).overflowY !== "visible")) {
      feed = feed.parentElement;
    }
    if (feed) feed.scrollTop = value;
  }, top);
  /** The middle of the `index`-th card wholly in the feed's view, and its slug. */
  const cardAt = (index) => page.evaluate((wanted) => {
    const cards = [...document.querySelectorAll("[data-block-slug]")];
    let feed = cards[0]?.parentElement ?? null;
    while (feed && !(feed.scrollHeight > feed.clientHeight && getComputedStyle(feed).overflowY !== "visible")) {
      feed = feed.parentElement;
    }
    const view = feed?.getBoundingClientRect();
    const shown = cards
      .map((card) => ({ card, rect: card.getBoundingClientRect() }))
      .filter(({ rect }) => view && rect.height > 0 && rect.top >= view.top + 40 && rect.bottom <= view.bottom - 40)
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const chosen = shown[wanted];
    if (!chosen) throw new Error(`no card ${wanted} in view`);
    return {
      x: chosen.rect.left + chosen.rect.width / 2,
      y: chosen.rect.top + chosen.rect.height / 2,
      slug: chosen.card.getAttribute("data-block-slug"),
    };
  }, index);
  /** Press on `from`, pass the drag's threshold, hold at `to` for HOLD_MS,
   *  then cancel with Escape and release. */
  const holdAt = async (from, to) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 15, from.y + 15, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 12 });
    for (let tick = 0; tick < HOLD_MS / 100; tick += 1) {
      await page.mouse.move(to.x + (tick % 2), to.y, { steps: 1 });
      await page.waitForTimeout(100);
    }
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await page.waitForTimeout(300);
  };
  const feedBox = await page.evaluate(() => {
    const card = document.querySelector("[data-block-slug]");
    let feed = card?.parentElement ?? null;
    while (feed && !(feed.scrollHeight > feed.clientHeight && getComputedStyle(feed).overflowY !== "visible")) {
      feed = feed.parentElement;
    }
    const rect = feed?.getBoundingClientRect();
    return rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null;
  });
  if (!feedBox) throw new Error("no feed scroll box");
  const midX = (feedBox.left + feedBox.right) / 2;

  // At the feed's bottom edge and past it.
  let before = await scrolls();
  await holdAt(await cardAt(4), { x: midX, y: feedBox.bottom - 4 });
  let after = await scrolls();
  check(after.feed === before.feed, `the feed stays at the bottom edge under a card (${before.feed} → ${after.feed})`);
  await holdAt(await cardAt(4), { x: midX, y: feedBox.bottom + 20 });
  after = await scrolls();
  check(after.feed === before.feed, `the feed stays past its bottom edge under a card (${before.feed} → ${after.feed})`);

  // At the top edge of a feed scrolled down.
  await setFeedScroll(900);
  await page.waitForTimeout(400);
  before = await scrolls();
  await holdAt(await cardAt(0), { x: midX, y: feedBox.top + 4 });
  after = await scrolls();
  check(before.feed > 0 && after.feed === before.feed, `the feed stays at the top edge under a card (${before.feed} → ${after.feed})`);
  await holdAt(await cardAt(0), { x: midX, y: feedBox.top - 15 });
  after = await scrolls();
  check(after.feed === before.feed, `the feed stays past its top edge under a card (${before.feed} → ${after.feed})`);

  // Over the sidebar's list near its bottom edge: the list scrolls, the feed
  // does not.
  const nav = await page.locator("[data-sidebar-scroll]").boundingBox();
  if (!nav) throw new Error("no sidebar list");
  before = await scrolls();
  await holdAt(await cardAt(0), { x: nav.x + nav.width / 2, y: nav.y + nav.height - 5 });
  after = await scrolls();
  check(after.sidebar > before.sidebar, `the sidebar's list scrolls near its edge under a card (${before.sidebar} → ${after.sidebar})`);
  check(after.feed === before.feed, `the feed stays while the card is over the sidebar (${before.feed} → ${after.feed})`);

  // A press still gives the card the focus, as WebKit's own press did.
  await page.keyboard.press("Escape");
  const pressed = await cardAt(2);
  await page.mouse.move(pressed.x, pressed.y);
  await page.mouse.down();
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-block-slug") ?? null);
  await page.mouse.up();
  check(focused === pressed.slug, `a press gives the card the focus (${focused})`);
} finally {
  await browser?.close();
  await vite.close();
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}
console.log("Card drag scroll audit passed.");
