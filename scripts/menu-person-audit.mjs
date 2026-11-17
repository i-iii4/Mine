// The menus as a person uses them, on the app's pages built for production
// (scripts/built-app-pages.mjs) in WebKit without a window: real presses,
// right clicks, keys and pointer moves, and what the person sees after each:
// where the menu stands, that it holds its rows, what closes it, which card
// looks hovered (SPEC_MENU_WINDOW.md, sections 3, 6, 7 and 10;
// SPEC_CARD_STATES.md, С7.8).
//
// Both places a menu opens:
//
// - on the page (the `Web` mode, and every refusal of the menu window): the
//   menu by a right click stands with its corner on the click, turned at the
//   window's right edge, moved up at its bottom; a button's menu stands 4 px
//   under the button's plate, its left edge on the plate's, turned at the
//   right edge (МО6, МО7, МО10–МО12, МО69). A press beside the menu only
//   closes it, Escape closes it and gives the focus back to its button, the
//   arrows light its rows and Enter chooses one;
// - in the menu window (the `Window` mode): the tab's page and the menu
//   window's page run side by side, and this audit stands for the backend
//   between them: it passes their messages on as the backend does and sets
//   the menu window's frame for the size the tab counted. The menu window
//   draws the menu the tab asked for, row for row the menu of the page; the
//   tab anchors a right click's menu on the click and a button's on its
//   visible plate; a choice made in the window runs in the tab; Escape in
//   the window and a press beside it close it.
//
// Where the backend puts the menu window on the screen is the backend's
// (src-tauri/src/menu_panel/geometry.rs, its Rust tests): this audit does
// not stand for that.
//
// A card a right click opened a menu on keeps its hovered look while the
// menu is open, in both places, and after it closed until the pointer shows
// off the card (С7.8, decision of 16.11.2026).
import { webkit } from "playwright";
import { PNG } from "pngjs";
import { installBackend, painted, spaceCards } from "./app-backend-stand-in.mjs";
import { PAGES, serveBuiltApp } from "./built-app-pages.mjs";

const VIEWPORT = { width: 1200, height: 760 };
/** The page's edge field (FLOATING_LAYER_EDGE_PX) and the gap off a plate
 *  (MENU_PLATE_GAP_PX), src/lib/floatingLayer.ts. */
const EDGE = 8;
const GAP = 4;
/** The menu window's field for the shadow (SHADOW_FIELD_PX, geometry.rs). */
const FIELD = 12;
const NEAR = 1;
/** A person's fastest answer to what shows up: a key pressed after the
 *  menu appeared is pressed this much later at the earliest. */
const REACTION_MS = 150;

const picture = (() => {
  const png = new PNG({ width: 400, height: 300 });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([90, 120, 160, 255], i);
  return PNG.sync.write(png);
})();

const failures = [];
function check(ok, label, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(`${label}${detail ? ` (${detail})` : ""}`);
}
const near = (a, b) => Math.abs(a - b) <= NEAR;
const round = (box) => box && Object.fromEntries(Object.entries(box).map(([key, value]) => [key, typeof value === "number" ? Math.round(value * 10) / 10 : value]));

const app = await serveBuiltApp({
  name: "menu-person-audit",
  respond(url, response) {
    if (url.pathname !== "/__asset") return false;
    response.writeHead(200, { "Content-Type": "image/png" });
    response.end(picture);
    return true;
  },
});

/** A tab's page of the space, the feed drawn. */
async function openTab(browser, { mode, relay = null }) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (relay) await page.exposeBinding("__auditRelay", (_source, command, args) => relay(command, args));
  await page.addInitScript(installBackend, {
    cards: spaceCards(),
    collections: ["Reading", "Design"],
    label: "main",
    relayed: relay ? ["menu_panel_open", "menu_panel_close", "menu_panel_update", "menu_panel_answer"] : [],
    answers: mode === "window" ? { menu_panel_prepare: { ready: true } } : {},
    storage: { "mine.motion": "off", theme: "light", ...(mode === "window" ? { "mine.menus": "window" } : {}) },
  });
  await page.goto(`${app.origin}${PAGES.tab}`);
  await page.waitForSelector("[data-block-slug]", { timeout: 60_000 });
  await painted(page, 4);
  if (mode === "window") {
    await page.waitForFunction(() => window.__auditCommands.some(({ command }) => command === "menu_panel_prepare"));
  }
  return { page, errors };
}

/** Cards wholly in the feed's view, with their boxes. */
function shownCards(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll("[data-block-slug]")];
    return cards.map((card) => {
      const box = card.getBoundingClientRect();
      return { slug: card.getAttribute("data-block-slug"), left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    }).filter((box) => box.width > 0 && box.top >= 48 && box.bottom <= window.innerHeight - 40);
  });
}

/** What the person sees of a card's hovered look: its hover shade and its
 *  buttons at the top right. */
function hovered(page, slug) {
  return page.evaluate((wanted) => {
    const card = document.querySelector(`[data-block-slug="${wanted}"]`);
    const overlay = card?.querySelector("[data-card-hover-overlay]");
    const actions = card?.querySelector("[data-card-hover-more-action]");
    if (!overlay || !actions) return null;
    return Number(getComputedStyle(overlay).opacity) > 0.5 && Number(getComputedStyle(actions).opacity) > 0.5;
  }, slug);
}

/** The menu open on the page: its box, rows, and the colour behind them. */
function pageMenu(page) {
  return page.evaluate(() => {
    const surface = [...document.querySelectorAll("[data-radix-menu-content]")]
      .find((element) => element.getAttribute("data-state") === "open" && !element.closest("[data-slot='dropdown-menu-sub-content']") && element.getAttribute("data-slot") !== "dropdown-menu-sub-content");
    if (!surface) return null;
    const box = surface.getBoundingClientRect();
    const rows = [...surface.querySelectorAll("[role='menuitem'],[role='menuitemcheckbox'],[role='menuitemradio']")]
      .filter((row) => row.closest("[data-radix-menu-content]") === surface)
      .map((row) => row.textContent.trim());
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height, rows, background: getComputedStyle(surface).backgroundColor };
  });
}

/** The visible plate of a button: the chrome plate inside it, or itself. */
function plateOf(locator) {
  return locator.evaluate((button) => {
    const box = (button.querySelector("[data-chrome-plate]") ?? button).getBoundingClientRect();
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
  });
}

/** Where a right click's menu of `size` stands on a page of `viewport`
 *  (МО10–МО12, МО69). */
function pointPlace(point, size) {
  const left = point.x + size.width <= VIEWPORT.width - EDGE ? point.x : point.x - size.width;
  const top = point.y + size.height <= VIEWPORT.height - EDGE ? point.y : VIEWPORT.height - EDGE - size.height;
  return { left, top };
}

/** Where a button's menu of `size` stands (МО6, МО7, МО69). */
function platePlace(plate, size) {
  const left = plate.left + size.width <= VIEWPORT.width - EDGE ? plate.left : plate.right - size.width;
  const top = plate.bottom + GAP + size.height <= VIEWPORT.height - EDGE ? plate.bottom + GAP : plate.top - GAP - size.height;
  return { left, top };
}

/** Wait for the stand-in backend's books to say `done`, 2 s at most: the
 *  messages it passes between the pages are on their way meanwhile. */
async function until(done) {
  for (let waited = 0; waited < 2_000 && !done(); waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
}

/** Move the pointer to `to` as a hand does: in steps, not a jump. */
async function moveTo(page, to, steps = 12) {
  await page.mouse.move(to.x, to.y, { steps });
  // The pointer comes to rest: a card a fast pass crossed answers a still
  // pointer within 60 ms (SPEC_CARD_STATES.md, С7.2).
  await page.waitForTimeout(120);
  await painted(page);
}

let browser;
/** The card menu's rows as the page draws them. */
let pageRowsOfCard;
try {
  browser = await webkit.launch({ headless: true });

  // ── On the page ───────────────────────────────────────────────────────
  {
    const { page, errors } = await openTab(browser, { mode: "web" });
    const cards = await shownCards(page);
    const leftmost = Math.min(...cards.map((card) => card.left));
    const rightmost = Math.max(...cards.map((card) => card.right));
    const left = cards.find((card) => card.left === leftmost);
    const right = cards.find((card) => card.right === rightmost);

    // A right click in the middle of a card of the left column.
    const point = { x: left.left + left.width / 2, y: left.top + left.height / 2 };
    await moveTo(page, point);
    check(await hovered(page, left.slug), "page: the card under the pointer looks hovered before the right click");
    await page.mouse.click(point.x, point.y, { button: "right" });
    await painted(page);
    const menu = await pageMenu(page);
    check(menu !== null, "page: a right click on a card opens its menu");
    const pageRows = menu?.rows ?? [];
    if (menu) {
      const want = pointPlace(point, menu);
      check(near(menu.left, want.left) && near(menu.top, want.top), "page: the right click's menu has its corner on the click", `click ${point.x},${point.y}; menu ${JSON.stringify(round(menu))}`);
      check(menu.rows.length >= 5 && menu.rows.every((row) => row.length > 0), "page: the menu holds its rows", JSON.stringify(menu.rows));
      check(!/rgba\(.*, 0\)|transparent/.test(menu.background), "page: the menu is drawn on its own surface", menu.background);
    }
    check(await hovered(page, left.slug), "page: the card keeps its hovered look while its menu is open");
    // The pointer goes over the menu's rows: the card stays hovered, the
    // card under the menu does not answer.
    if (menu) await moveTo(page, { x: menu.left + menu.width / 2, y: menu.top + menu.height - 20 });
    check(await hovered(page, left.slug), "page: the card keeps its hovered look while the pointer is on its menu");
    // Escape closes the menu; the look stays until the pointer is off the card.
    await page.keyboard.press("Escape");
    await painted(page);
    check(await pageMenu(page) === null, "page: Escape closes the right click's menu");
    await moveTo(page, { x: 200, y: 600 });
    check(!(await hovered(page, left.slug)), "page: the card's hovered look goes once the pointer is off the card and off the menu");

    // At the window's right edge the menu turns left of the click.
    const edgePoint = { x: right.right - 12, y: right.top + 30 };
    await moveTo(page, edgePoint);
    await page.mouse.click(edgePoint.x, edgePoint.y, { button: "right" });
    await painted(page);
    const turned = await pageMenu(page);
    if (turned) {
      const want = pointPlace(edgePoint, turned);
      check(near(turned.right, edgePoint.x) && near(turned.left, want.left) && near(turned.top, want.top), "page: at the right edge the menu turns, its right corner on the click", `click ${edgePoint.x},${edgePoint.y}; menu ${JSON.stringify(round(turned))}`);
      check(turned.left >= EDGE - NEAR, "page: the turned menu stays inside the window", `left ${turned.left}`);
    } else check(false, "page: a right click at the right edge opens the menu");
    // A press beside the menu, on another card, only closes the menu.
    const other = cards.find((card) => card.slug !== right.slug && card.slug !== left.slug && card.left > leftmost);
    const before = await page.evaluate(() => ({ path: location.pathname + location.search, opens: window.__auditCommands.filter(({ command }) => command === "begin_note_edit").length }));
    await moveTo(page, { x: other.left + 20, y: other.top + 20 });
    await page.mouse.click(other.left + 20, other.top + 20);
    await painted(page, 4);
    const after = await page.evaluate(() => ({ path: location.pathname + location.search, opens: window.__auditCommands.filter(({ command }) => command === "begin_note_edit").length, open: document.querySelector("[data-detail-root],[data-card-peek]") !== null }));
    check(await pageMenu(page) === null, "page: a press beside the menu closes it");
    check(after.path === before.path && after.opens === before.opens && !after.open, "page: the press that closes the menu does not open the card under it", `${JSON.stringify(before)} → ${JSON.stringify(after)}`);

    // At the window's bottom the menu moves up to stand inside it: a right
    // click on whatever card is under the point 50 px over the window's
    // bottom, in the left column.
    {
      const lowPoint = await page.evaluate((x) => {
        for (let y = window.innerHeight - 50; y > window.innerHeight - 120; y -= 5) {
          if (document.elementFromPoint(x, y)?.closest("[data-block-slug]")) return { x, y };
        }
        return null;
      }, leftmost + 30);
      if (lowPoint) {
        await moveTo(page, lowPoint);
        await page.mouse.click(lowPoint.x, lowPoint.y, { button: "right" });
        await painted(page);
        const raised = await pageMenu(page);
        if (raised) {
          check(near(raised.bottom, VIEWPORT.height - EDGE) && near(raised.left, lowPoint.x), "page: at the bottom the menu moves up, its bottom on the window's edge field", `click ${lowPoint.x},${lowPoint.y}; menu ${JSON.stringify(round(raised))}`);
        } else check(false, "page: a right click near the bottom opens the menu");
        await page.keyboard.press("Escape");
        await painted(page);
      } else check(false, "page: a card near the window's bottom to right click");
    }

    // The card's `More` button: under its plate, its left edge on the plate's.
    for (const [name, card] of [["left column", left], ["right column", right]]) {
      await moveTo(page, { x: card.left + card.width / 2, y: card.top + card.height / 2 });
      const button = page.locator(`[data-block-slug="${card.slug}"] button[aria-label="Element actions"]`);
      await button.waitFor({ state: "visible" });
      const box = await button.boundingBox();
      await moveTo(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, 6);
      const plate = await plateOf(button);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await painted(page);
      const opened = await pageMenu(page);
      if (!opened) {
        check(false, `page, ${name}: More opens the card's menu`);
        continue;
      }
      const want = platePlace(plate, opened);
      check(near(opened.left, want.left) && near(opened.top, want.top), `page, ${name}: More's menu stands under the plate, right and down unless the edge turns it`, `plate ${JSON.stringify(round(plate))}; menu ${JSON.stringify(round(opened))}; want ${JSON.stringify(round(want))}`);
      check(JSON.stringify(opened.rows) === JSON.stringify(pageRows), `page, ${name}: More opens the same menu as the right click`, JSON.stringify(opened.rows));
      await page.waitForTimeout(REACTION_MS);
      // The keys: the arrows light the rows in turn. Escape closes; a menu
      // a press opened gives the focus to nothing, so the button that shows
      // under the pointer draws no focus ring (С8.8, `noFocusBackAfterPress`).
      await page.keyboard.press("ArrowDown");
      const firstLit = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? null);
      await page.keyboard.press("ArrowDown");
      const secondLit = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? null);
      check(firstLit !== null && secondLit !== null && firstLit !== secondLit && opened.rows.includes(secondLit), `page, ${name}: the arrows light the menu's rows in turn`, `${firstLit} → ${secondLit}`);
      await page.keyboard.press("Escape");
      await painted(page);
      const focus = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName);
      check(await pageMenu(page) === null && focus !== "Element actions", `page, ${name}: Escape closes More's menu and gives the focus to nothing`, `focus on ${focus}`);
    }

    // Enter chooses the lit row: Reveal in Finder asks the system.
    {
      await moveTo(page, { x: left.left + left.width / 2, y: left.top + left.height / 2 });
      await page.mouse.click(left.left + left.width / 2, left.top + left.height / 2, { button: "right" });
      await painted(page);
      // A person reads the menu before pressing a key.
      await page.waitForTimeout(REACTION_MS);
      for (let step = 0; step < 12; step += 1) {
        await page.keyboard.press("ArrowDown");
        const lit = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
        if (lit === "Reveal in Finder") break;
      }
      await page.keyboard.press("Enter");
      await page.waitForTimeout(400);
      const asked = await page.evaluate(() => window.__auditCommands.filter(({ command }) => command.includes("reveal")).map(({ command, args }) => ({ command, args })));
      check(await pageMenu(page) === null && asked.length === 1, "page: Enter on Reveal in Finder closes the menu and asks the system once", JSON.stringify(asked));
    }

    // The Display button at the window's top right: under its plate, turned
    // at the edge.
    {
      const button = page.locator("button[aria-label='Display options']").first();
      const plate = await plateOf(button);
      const box = await button.boundingBox();
      await moveTo(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await painted(page);
      const opened = await pageMenu(page);
      if (opened) {
        const want = platePlace(plate, opened);
        check(near(opened.left, want.left) && near(opened.top, want.top) && opened.right <= VIEWPORT.width - EDGE + NEAR, "page: the Display panel stands under its button, turned at the window's right edge", `plate ${JSON.stringify(round(plate))}; menu ${JSON.stringify(round(opened))}`);
        await page.mouse.click(300, 400);
        await painted(page);
        check(await pageMenu(page) === null, "page: a press beside the Display panel closes it");
        // From the keyboard: the button reached by Tab, Enter opens the panel
        // with its first row lit (МО49), Escape closes it and the button has
        // the focus again (МО53; a pointer's opening gives it to nothing,
        // `useTopChromeTriggerInteraction`).
        await button.focus();
        await page.keyboard.press("Enter");
        await painted(page);
        const byKey = await pageMenu(page);
        const lit = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? null);
        check(byKey !== null && lit === byKey.rows[0], "page: Enter on the focused Display button opens the panel with its first row lit", `lit ${lit}`);
        await page.keyboard.press("Escape");
        await painted(page);
        const focus = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName);
        check(await pageMenu(page) === null && focus === "Display options", "page: Escape closes the panel a key opened and gives the focus back to its button", `focus on ${focus}`);
      } else check(false, "page: the Display button opens its panel");
    }
    check(errors.length === 0, "page: no page errors", errors.join("; "));
    await page.close();
    pageRowsOfCard = pageRows;
  }

  // ── In the menu window ────────────────────────────────────────────────
  {
    const panel = await browser.newPage({ viewport: { width: 264, height: 56 }, deviceScaleFactor: 1 });
    const panelErrors = [];
    panel.on("pageerror", (error) => panelErrors.push(error.message));
    let tab = null;
    /** The backend's books of the open menu. */
    let open = null;
    const toPanel = async (body) => {
      open.panelSeq += 1;
      await panel.evaluate((message) => window.__auditFire("menu-panel-to-page", message), { source: open.page, menu: open.menu, seq: open.panelSeq, body });
      await painted(panel);
    };
    const toTab = async (body) => {
      open.tabSeq += 1;
      await tab.evaluate((message) => window.__auditFire("menu-panel-to-source", message), { menu: open.menu, seq: open.tabSeq, body });
      await painted(tab);
    };
    /** The backend closes the menu, as on a press beside the window. */
    const closeAs = async (reason) => {
      await toPanel({ kind: "closed", reason });
      await toTab({ kind: "closed", reason, key_returned: true });
      open.closed = reason;
    };
    const relayOfTab = async (command, args) => {
      if (command === "menu_panel_open") {
        const request = args.request;
        const widest = Math.max(0, ...request.submenus.map((submenu) => submenu.width));
        const lowest = Math.max(request.size.height, ...request.submenus.map((submenu) => submenu.row_top + submenu.height));
        const frame = { width: request.size.width + widest + 2 * FIELD, height: lowest + 2 * FIELD };
        open = { request, page: request.page, menu: request.menu, panelSeq: 0, tabSeq: 0, frame, closed: null };
        await panel.setViewportSize(frame);
        const menu = { x: FIELD, y: FIELD, width: request.size.width, height: request.size.height };
        const anchor = request.opener.kind === "point"
          ? { anchor: { x: menu.x, y: menu.y }, side: "right", align: "start" }
          : { anchor: { x: menu.x, y: menu.y - GAP }, side: "bottom", align: "start" };
        await toPanel({ kind: "open", size: request.size, spec: request.spec, by_key: request.by_key, buttons: request.buttons, layout: { menu, origin: { x: 0, y: 0 }, frame, ...anchor, max_height: null, submenu_right: true } });
        return null;
      }
      if (command === "menu_panel_close") {
        if (open && open.menu === args.menu && open.closed === null) {
          await toPanel({ kind: "closed", reason: args.reason });
          open.closed = args.reason;
          return { closed: true, key_returned: true };
        }
        return { closed: false, key_returned: false };
      }
      if (command === "menu_panel_update" && open?.menu === args.menu) await toPanel({ kind: "update", spec: args.spec });
      if (command === "menu_panel_answer" && open?.menu === args.menu) await toPanel({ kind: "answer", request: args.request, answer: args.answer });
      return null;
    };
    await panel.exposeBinding("__auditRelay", async (_source, command, args) => {
      if (command !== "menu_panel_request" || open === null || args.request.menu !== open.menu || open.closed) return null;
      const { request, action, close } = args.request;
      if (action !== null) await toTab({ kind: "action", request, action });
      if (close !== null) await closeAs(close);
      return null;
    });
    await panel.addInitScript(installBackend, { label: "menu-panel", relayed: ["menu_panel_request"], storage: { "mine.motion": "off", theme: "light" } });
    await panel.goto(`${app.origin}${PAGES.menuPanel}`);
    await panel.waitForFunction(() => window.__auditCommands.some(({ command }) => command === "menu_panel_ready"), null, { timeout: 60_000 });

    const opened = await openTab(browser, { mode: "window", relay: relayOfTab });
    tab = opened.page;
    const cards = await shownCards(tab);
    const leftmost = Math.min(...cards.map((card) => card.left));
    const card = cards.find((item) => item.left === leftmost);
    /** What the menu window shows. */
    const panelMenu = () => panel.evaluate(() => {
      const surface = document.querySelector("[data-menu-panel-surface]");
      if (!surface) return null;
      const box = surface.getBoundingClientRect();
      const rows = [...surface.querySelectorAll("[role='menuitem'],[role='menuitemcheckbox'],[role='menuitemradio']")]
        .filter((row) => !row.closest("[data-slot='dropdown-menu-sub-content']"))
        .map((row) => row.textContent.trim());
      return { width: box.width, height: box.height, rows };
    });

    // A right click: the tab asks for the menu at the click, the window
    // draws it, the card keeps its hovered look.
    const point = { x: card.left + card.width / 2, y: card.top + card.height / 2 };
    await moveTo(tab, point);
    await tab.mouse.click(point.x, point.y, { button: "right" });
    await tab.waitForFunction(() => window.__auditCommands.some(({ command }) => command === "menu_panel_open"));
    await panel.waitForSelector("[data-menu-panel-surface]", { timeout: 2_000 }).catch(() => undefined);
    let drawn = await panelMenu();
    check(open?.request.opener.kind === "point" && near(open.request.anchor.x, point.x) && near(open.request.anchor.y, point.y) && open.request.anchor.width === 0, "window: the right click's menu is anchored on the click", JSON.stringify(open?.request.anchor));
    check(drawn !== null && drawn.rows.length >= 5, "window: the menu window draws the menu, not an empty frame", JSON.stringify(drawn));
    check(drawn !== null && JSON.stringify(drawn.rows) === JSON.stringify(pageRowsOfCard), "window: the menu window holds the rows the menu has on the page", JSON.stringify(drawn?.rows));
    check(drawn !== null && near(drawn.width, open.request.size.width) && drawn.height <= open.request.size.height + NEAR, "window: the drawn menu is the size the tab counted for its frame", `${JSON.stringify(round(drawn))} vs ${JSON.stringify(open?.request.size)}`);
    check(await tab.evaluate(() => document.querySelector("[data-radix-menu-content][data-state='open']") === null), "window: the tab draws no menu of its own meanwhile");
    check(await hovered(tab, card.slug), "window: the card keeps its hovered look while its menu is open in the window");
    // Escape in the menu window closes it; the tab hears it.
    await panel.locator("[data-menu-panel-surface]").focus().catch(() => undefined);
    await panel.keyboard.press("Escape");
    await painted(panel);
    await painted(tab);
    await until(() => open?.closed !== null);
    check(open?.closed === "escape" && await panelMenu() === null, "window: Escape in the menu window closes the menu", String(open?.closed));
    check(await hovered(tab, card.slug), "window: after the menu closed the card keeps its look while the pointer has not moved off it");
    await moveTo(tab, { x: 200, y: 600 });
    check(!(await hovered(tab, card.slug)), "window: the card's hovered look goes once the pointer is off it");

    // A choice in the window runs in the tab.
    await moveTo(tab, point);
    await tab.mouse.click(point.x, point.y, { button: "right" });
    await panel.waitForSelector("[data-menu-panel-surface]", { timeout: 2_000 }).catch(() => undefined);
    const revealsBefore = await tab.evaluate(() => window.__auditCommands.filter(({ command }) => command.includes("reveal")).length);
    const row = panel.locator("[data-menu-panel-surface] [role='menuitem']", { hasText: "Reveal in Finder" });
    if (await row.count() === 1) {
      const box = await row.boundingBox();
      await panel.mouse.move(box.x + 20, box.y + box.height / 2, { steps: 4 });
      await panel.mouse.click(box.x + 20, box.y + box.height / 2);
      await until(() => open?.closed !== null);
      await painted(tab);
      const reveals = await tab.evaluate(() => window.__auditCommands.filter(({ command }) => command.includes("reveal")).length);
      check(reveals === revealsBefore + 1 && open?.closed === "chosen", "window: Reveal in Finder chosen in the window runs once in the tab and closes the menu", `asked ${reveals - revealsBefore}, closed ${open?.closed}`);
    } else check(false, "window: the menu window has Reveal in Finder");

    // A press beside the window: the backend closes the menu, the tab forgets it.
    await moveTo(tab, { x: card.left + card.width / 2, y: card.top + card.height / 2 });
    const button = tab.locator(`[data-block-slug="${card.slug}"] button[aria-label="Element actions"]`);
    await button.waitFor({ state: "visible" });
    const box = await button.boundingBox();
    await moveTo(tab, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, 6);
    const plate = await plateOf(button);
    await tab.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await panel.waitForSelector("[data-menu-panel-surface]", { timeout: 2_000 }).catch(() => undefined);
    drawn = await panelMenu();
    check(open?.request.opener.kind === "plate" && near(open.request.anchor.x, plate.left) && near(open.request.anchor.y, plate.top) && near(open.request.anchor.width, plate.right - plate.left) && near(open.request.anchor.height, plate.bottom - plate.top), "window: More's menu is anchored on the button's visible plate", `anchor ${JSON.stringify(round(open?.request.anchor))}, plate ${JSON.stringify(round(plate))}`);
    check(drawn !== null && JSON.stringify(drawn.rows) === JSON.stringify(pageRowsOfCard), "window: More's menu window holds the card's menu", JSON.stringify(drawn?.rows));
    check(await button.getAttribute("data-state") === "open", "window: More looks pressed while its menu is open in the window");
    await closeAs("outside");
    check(await panelMenu() === null && await button.getAttribute("data-state") !== "open", "window: a press beside the menu closes it and More no longer looks pressed", String(await button.getAttribute("data-state")));
    // Pressing More again opens the menu again (the tab forgot the closed one).
    await tab.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await panel.waitForSelector("[data-menu-panel-surface]", { timeout: 2_000 }).catch(() => undefined);
    check(await panelMenu() !== null, "window: More opens its menu again after a press beside it closed it");
    await closeAs("outside");

    check(opened.errors.length === 0 && panelErrors.length === 0, "window: no page errors", [...opened.errors, ...panelErrors].join("; "));
    await tab.close();
    await panel.close();
  }
} finally {
  await browser?.close();
  await app.close();
}

if (failures.length > 0) {
  console.error(`Menu person audit failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}
console.log("Menu person audit passed.");
