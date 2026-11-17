// TRIAL (SPEC_MENU_WINDOW.md, МО74; DESIGN_SYSTEM.md, «Меню карточки в
// отдельном окне: проба»): the menu panel's page in WebKit without a window,
// its own Vite (audit-vite.mjs). It holds what the panel's window shows to
// its pixels, for every menu that opens in the panel:
//
// - at rest the page draws nothing: every pixel of a snapshot with no
//   background is clear, in both themes. The trial's first run in the app
//   (15.11.2026) stood as an opaque square the size of the panel: global.css
//   paints `#root` with the theme's background by its id;
// - a drawn menu is opaque, its shadow is drawn by the page and lies whole
//   inside the panel's frame, and everything else stays clear;
// - the menu as laid out is the size the page it came from counts from its
//   description (`menuSpecSize`): the backend sets the panel's frame by that
//   count before the panel's page has drawn anything (МО28, МО29). A menu
//   whose height changes while open is counted at its largest and is never
//   drawn larger;
// - the menu stands where the backend's layout puts it, for a button's menu
//   and for a right click's, whose corner the backend sets on the point of
//   the click with no offset (МО10): the page adds none of its own;
// - a submenu opens inside the frame on the side the backend chose, no
//   larger than counted (МО31);
// - the page draws a menu only once its area is the frame the backend set
//   for it (МО30);
// - the keys work in the page (МО49 to МО51): the arrows, Enter, Escape, the
//   search field's own Escape, typing.
//
// The backend's messages come as it sends them: one event, the menu named by
// its page and its number, each message counted (МО35, МО36).
//
// The page's Tauri is a stand-in that delivers the backend's events and
// records the page's commands.
import assert from "node:assert/strict";
import { webkit } from "playwright";
import { PNG } from "pngjs";
import { COLD_START_MS, startAuditVite } from "./audit-vite.mjs";

/** The panel before its first menu (src-tauri/src/menu_panel/geometry.rs,
 *  `REST_WIDTH_PX`, `REST_HEIGHT_PX`). */
const REST = { width: 264, height: 56 };
const FIELD = 12;

function installTauri() {
  const callbacks = new Map();
  const listeners = [];
  let next = 1;
  window.__auditCommands = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "menu-panel" }, currentWebview: { label: "menu-panel" } },
    transformCallback(callback) {
      const id = next++;
      callbacks.set(id, callback);
      return id;
    },
    async invoke(command, args) {
      if (command === "plugin:event|listen") {
        listeners.push({ event: args.event, handler: args.handler });
        return listeners.length;
      }
      window.__auditCommands.push({ command, args });
      return null;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__auditFire = (event, payload) => {
    for (const listener of listeners) {
      if (listener.event === event) callbacks.get(listener.handler)?.({ event, id: 0, payload });
    }
  };
}

/** Pixels with any alpha in `png` inside `rect`, or outside it with `outside`. */
function opaquePixels(png, rect = null, outside = false) {
  let count = 0;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const inRect = rect !== null && x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
      if (rect !== null && inRect === outside) continue;
      if (png.data[(y * png.width + x) * 4 + 3] > 0) count += 1;
    }
  }
  return count;
}

function alphaAt(png, x, y) {
  return png.data[(Math.round(y) * png.width + Math.round(x)) * 4 + 3];
}

/** Twenty collections: the picker's list at its most rows, and a scroll. */
const MANY = Array.from({ length: 20 }, (_, index) => ({ tag: `Collection ${String(index + 1).padStart(2, "0")}`, count: index }));

/** The menus that open in the panel, by what the page they come from holds. */
const SHAPES = [
  { name: "card menu: link, collection, table", kind: "menu", hasUrl: true, disconnectFrom: "Web", table: true, tags: MANY, rightClick: false },
  { name: "card menu: no link", kind: "menu", hasUrl: false, disconnectFrom: null, table: false, tags: [{ tag: "Web", count: 1 }], rightClick: false },
  { name: "card menu by a right click", kind: "menu", hasUrl: true, disconnectFrom: null, table: false, tags: MANY, rightClick: true },
  { name: "Connect: many collections", kind: "connect", tags: MANY, rightClick: false },
  { name: "Connect: one collection, turned at the screen's right edge", kind: "connect", tags: [{ tag: "Web", count: 1 }], rightClick: false, turned: true },
  { name: "selection's menu by a right click", kind: "group", error: null, tags: MANY, rightClick: true },
  { name: "selection's menu with a failed read", kind: "group", error: "The collections could not be read.", tags: MANY, rightClick: false },
  { name: "selection's Connect", kind: "group-connect", tags: MANY, rightClick: false },
  { name: "media file's menu", kind: "media", error: null, tags: MANY, rightClick: false },
  { name: "media file's menu with a failed copy", kind: "media", error: "Media file was not found.", tags: MANY, rightClick: true },
  { name: "new card's collection", kind: "new-card", tags: MANY, rightClick: false },
  { name: "embedded video's menu, a download running", kind: "source-video", tags: [], rightClick: true },
  { name: "feed's Display panel with the Peek window's width", kind: "display-feed", tags: [], rightClick: false },
  { name: "graph's Display panel", kind: "display-graph", tags: [], rightClick: false },
  { name: "logo's menu", kind: "settings", tags: [], rightClick: false },
  { name: "settings window's open spaces", kind: "open-spaces", tags: [], rightClick: false },
  { name: "settings window's space actions", kind: "space-actions", tags: [], rightClick: false },
  { name: "space menu: ten spaces", kind: "spaces", count: 10, tags: [], rightClick: false },
  { name: "space menu: two spaces, one gone", kind: "spaces", count: 2, tags: [], rightClick: false },
  { name: "collection row's menu, its page not found yet", kind: "collection-row", tags: [], rightClick: true },
  { name: "tab's menu, the only tab's", kind: "tab", tags: [], rightClick: true },
  { name: "tab bar's logo menu", kind: "bar-settings", tags: [], rightClick: false, exactSubmenu: true },
];

/** Build the opening of `shape` in the page and keep it there: the menu's
 *  description, the sizes its page counts, and the frame and the layout the
 *  backend makes of them for a menu at the frame's corner
 *  (src-tauri/src/menu_panel/geometry.rs, `panel_frame`, `panel_anchor`). */
async function prepare(page, shape) {
  return page.evaluate(async ({ shape, FIELD }) => {
    const { cardConnectSpec, cardMenuSpec } = await import("/src/lib/cardMenuEntries.ts");
    const { groupConnectSpec, groupSelectionSpec } = await import("/src/lib/groupSelectionMenu.ts");
    const { mediaAssetSpec, newCardSpec, sourceVideoSpec } = await import("/src/lib/openCardMenus.ts");
    const { displayChoice, displaySpec } = await import("/src/lib/displayMenu.ts");
    const { barSettingsSpec, tabMenuSpec } = await import("/src/tabbar/barMenus.ts");
    const { collectionRowSpec } = await import("/src/lib/collectionRowMenu.ts");
    const { menuItem, menuSpecSize } = await import("/src/lib/menuSpec.ts");
    const choices = (...labels) => labels.map((label) => ({ value: label, label }));
    const cardView = [
      ...displayChoice("card-view", "Element view", "Peek", choices("Full page", "Peek")),
      ...displayChoice("peek-width", "Peek width", "Fit element", choices("Fit element", "Fill")),
    ];
    const chrome = {
      "display-feed": () => displaySpec([
        displayChoice("sort", "Sort", shape.sort ?? "Newest first", choices("Newest first", "Oldest first")),
        displayChoice("show", "Show", "Media and Text", choices("Media and Text", "Text on Hover", "Media Only")),
        displayChoice("spacing", "Spacing", "32", choices("32", "24", "16", "8", "2")),
        cardView,
      ]),
      "display-graph": () => displaySpec([
        [
          { kind: "caption", text: "Links" },
          { kind: "checkbox", id: "links.wikilinks", label: "Wikilinks", checked: true },
          { kind: "checkbox", id: "links.related", label: "Related notes", checked: false },
        ],
        cardView,
      ]),
      settings: () => ({
        role: "action",
        entries: ["Appearance", "Shortcuts", "Graph", "Spaces", "New files", "Updates", "Orphans"].map((label) => menuItem(label, label, { plain: true })),
      }),
      // A space's name longer than the row is cut, the menu keeps its width.
      "open-spaces": () => ({
        role: "action",
        entries: [{
          kind: "radio",
          id: "space",
          value: "mine",
          options: [
            { value: "mine", label: "Mine" },
            { value: "archive", label: "An archive of everything saved before the move to the new library" },
          ],
          closes: true,
        }],
      }),
      spaces: () => ({
        role: "search",
        entries: [{
          kind: "widget",
          id: "spaces",
          widget: {
            kind: "space_list",
            spaces: Array.from({ length: shape.count }, (_, index) => ({ path: `/spaces/Space ${index + 1}`, name: `Space ${index + 1}`, tab: index % 2 === 0 })),
            unavailable: shape.count < 8 ? [{ path: "/spaces/Gone", name: "Gone", tab: false }] : [],
            tabs: true,
          },
        }],
      }),
      "collection-row": () => collectionRowSpec({ pageFound: false }),
      tab: () => tabMenuSpec(0, 1),
      "bar-settings": () => barSettingsSpec("macos", "window"),
      "space-actions": () => ({
        role: "action",
        entries: [menuItem("remove", "Remove Space", { icon: "unlink", variant: "detach", detail: "Files stay on disk" })],
      }),
    };
    const picker = { card: "card", selected: ["Web"], tags: shape.tags, currentTag: "Web" };
    const groupPicker = { cards: ["one", "two"], tags: shape.tags, lookup: new Map([["one", ["Collection 01"]], ["two", ["Collection 01"]]]) };
    const spec = shape.kind in chrome
      ? chrome[shape.kind]()
      : shape.kind === "connect"
      ? cardConnectSpec(picker)
      : shape.kind === "group-connect"
        ? groupConnectSpec(groupPicker)
        : shape.kind === "group"
          ? groupSelectionSpec({ count: 2, inCollection: true, error: shape.error, picker: groupPicker })
          : shape.kind === "media"
            ? mediaAssetSpec({ tags: shape.tags, currentTag: "Web", copyError: shape.error })
            : shape.kind === "new-card"
              ? newCardSpec(shape.tags, "Web")
              : shape.kind === "source-video"
                ? sourceVideoSpec({ downloading: true })
                : cardMenuSpec({
                  hasUrl: shape.hasUrl,
                  disconnectFrom: shape.disconnectFrom,
                  tableCommands: shape.table ? [{ id: "a", label: "Add Row Above", destructive: false, separatorBefore: false }] : [],
                  picker,
                });
    const { size, submenus } = menuSpecSize(spec);
    const menu = { x: FIELD, y: FIELD, width: size.width, height: size.height };
    const widest = Math.max(0, ...submenus.map((submenu) => submenu.width));
    const lowest = Math.max(size.height, ...submenus.map((submenu) => submenu.row_top + submenu.height));
    const frame = { width: size.width + widest + 2 * FIELD, height: lowest + 2 * FIELD };
    // A button's menu opens right and down off its plate, its left edge on
    // the plate's; turned at the screen's right edge, its right edge on the
    // plate's (SPEC_MENU_WINDOW.md, МО7).
    const anchor = shape.rightClick
      ? { anchor: { x: menu.x - 4, y: menu.y }, side: "right", align: "start" }
      : shape.turned
        ? { anchor: { x: menu.x + menu.width, y: menu.y - 4 }, side: "bottom", align: "end" }
        : { anchor: { x: menu.x, y: menu.y - 4 }, side: "bottom", align: "start" };
    window.__auditMenu = (window.__auditMenu ?? 0) + 1;
    window.__auditOpening = {
      source: "tab-audit",
      menu: window.__auditMenu,
      seq: 1,
      body: {
        kind: "open",
        size,
        spec,
        by_key: false,
        buttons: null,
        layout: { menu, origin: { x: 0, y: 0 }, frame, ...anchor, max_height: null, submenu_right: true },
      },
    };
    return { size, submenus, frame };
  }, { shape, FIELD });
}

/** The backend's opening kept by `prepare` reaches the page. */
async function fire(page) {
  await page.evaluate(async () => {
    window.__auditFire("menu-panel-to-page", window.__auditOpening);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

/** The backend closes the menu the page draws: its message number `seq` of
 *  the menu, the second unless the page has heard more. */
async function closeMenu(page, seq = 2) {
  await page.evaluate(async (seq) => {
    window.__auditFire("menu-panel-to-page", { source: "tab-audit", menu: window.__auditMenu, seq, body: { kind: "closed", reason: "outside" } });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, seq);
  await page.waitForFunction(() => document.querySelector("[data-menu-panel-surface]") === null);
}

/** What the page asked of the backend for the menu it draws now. */
async function requests(page) {
  return page.evaluate(() => window.__auditCommands
    .filter(({ command, args }) => command === "menu_panel_request" && args.request.menu === window.__auditMenu)
    .map(({ args }) => args.request));
}

async function surfaceBox(page) {
  return page.evaluate(() => {
    const surface = document.querySelector("[data-menu-panel-surface]");
    if (surface === null) return null;
    const box = surface.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height, shadow: getComputedStyle(surface).boxShadow };
  });
}

const vite = await startAuditVite();
let browser;
const failures = [];
try {
  browser = await webkit.launch({ headless: true });
  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage({ viewport: REST, deviceScaleFactor: 1 });
    page.setDefaultNavigationTimeout(COLD_START_MS);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(installTauri);
    await page.addInitScript((theme) => {
      localStorage.setItem("theme", theme);
      // The menu lands at once, at the level the person can choose.
      localStorage.setItem("mine.motion", "off");
    }, theme);
    await page.goto(`${vite.origin}/menu-panel.html`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__auditCommands.some(({ command }) => command === "menu_panel_ready"));

    const rest = PNG.sync.read(await page.screenshot({ omitBackground: true }));
    const restOpaque = opaquePixels(rest);
    const backgrounds = await page.evaluate(() => ["html", "body", "#root"].map((selector) => getComputedStyle(document.querySelector(selector)).backgroundColor));
    console.log(`${theme}: at rest ${restOpaque} of ${rest.width * rest.height} pixels not clear; html, body, #root: ${backgrounds.join(", ")}`);
    if (restOpaque !== 0) failures.push(`${theme}: the page at rest is not clear`);

    for (const shape of SHAPES) {
      const label = `${theme}, ${shape.name}`;
      const { size, submenus, frame } = await prepare(page, shape);
      // The backend sets the panel's frame for this menu, then tells the page.
      await page.setViewportSize(frame);
      await fire(page);
      const box = await surfaceBox(page);
      if (box === null) {
        failures.push(`${label}: the menu was not drawn`);
        continue;
      }
      const painted = await page.evaluate(() => window.__auditCommands
        .filter(({ command, args }) => command === "menu_panel_painted" && args.paint.menu === window.__auditMenu)
        .map(({ args }) => args.paint).at(-1) ?? null);
      const shot = PNG.sync.read(await page.screenshot({ omitBackground: true }));
      console.log(`${label}: frame ${frame.width}x${frame.height}; counted ${size.width}x${size.height}, laid out ${box.width}x${box.height} at ${box.x},${box.y}; painted report ${JSON.stringify(painted?.measured)}`);
      if (Math.abs(box.width - size.width) > 0.5) failures.push(`${label}: the menu is not the width its role counts`);
      // The count is the largest the menu gets: a list of fewer rows than the
      // most is lower, every other menu is the count exactly.
      const lower = ((shape.kind === "connect" || shape.kind === "group-connect") && shape.tags.length < 8)
        || (shape.kind === "spaces" && shape.count < 8);
      if (lower ? box.height > size.height + 0.5 : Math.abs(box.height - size.height) > 0.5) failures.push(`${label}: the menu is not the height its description counts`);
      if (Math.abs(box.x - FIELD) > 0.5 || Math.abs(box.y - FIELD) > 0.5) failures.push(`${label}: the menu is not where the layout puts it`);
      if (painted === null) failures.push(`${label}: no paint report`);
      // The menu is opaque.
      if (alphaAt(shot, box.x + box.width / 2, box.y + box.height / 2) !== 255) failures.push(`${label}: the menu is not opaque`);
      // The page draws the shadow: below the menu, inside the field.
      const below = alphaAt(shot, box.x + box.width / 2, box.y + box.height + 3);
      if (!(below > 0)) failures.push(`${label}: no shadow under the menu`);
      // Nothing beyond the menu and its field: the shadow is whole inside it
      // and the rest of the frame is clear.
      const field = { x: box.x - FIELD, y: box.y - FIELD, width: box.width + 2 * FIELD, height: box.height + 2 * FIELD };
      const outside = opaquePixels(shot, field, true);
      const edgeOfField = [
        alphaAt(shot, field.x, box.y + box.height / 2),
        alphaAt(shot, field.x + field.width - 1, box.y + box.height / 2),
        alphaAt(shot, box.x + box.width / 2, field.y + field.height - 1),
      ];
      console.log(`${label}: shadow ${box.shadow}; alpha below the menu ${below}; pixels beyond the field ${outside}; alpha at the field's edges ${edgeOfField.join(", ")}`);
      if (outside !== 0) failures.push(`${label}: pixels beyond the menu's field are not clear`);
      if (edgeOfField.some((alpha) => alpha > 0)) failures.push(`${label}: the shadow reaches the field's edge`);

      // The submenu: inside the frame, right of the menu, no larger than
      // counted, and as tall as counted with a list of the most rows.
      if (submenus.length > 0) {
        await page.locator("[data-menu-panel-surface] [role='menuitem'][aria-haspopup='menu']").first().focus();
        await page.keyboard.press("ArrowRight");
        await page.waitForSelector("[data-slot='dropdown-menu-sub-content']");
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const sub = await page.evaluate(() => {
          const box = document.querySelector("[data-slot='dropdown-menu-sub-content']").getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        });
        const counted = submenus[0];
        console.log(`${label}: submenu counted ${counted.width}x${counted.height} off row ${counted.row_top}, laid out ${sub.width}x${sub.height} at ${sub.x},${sub.y}`);
        if (sub.x < box.x + box.width - 6) failures.push(`${label}: the submenu is not right of the menu`);
        if (Math.abs(sub.y - (box.y + counted.row_top)) > 0.5) failures.push(`${label}: the submenu's top is not on its row's`);
        if (Math.abs(sub.width - counted.width) > 0.5) failures.push(`${label}: the submenu is not the width its role counts`);
        if (shape.tags.length >= 8 || shape.exactSubmenu ? Math.abs(sub.height - counted.height) > 0.5 : sub.height > counted.height + 0.5) failures.push(`${label}: the submenu is not the height its description counts`);
        if (sub.x + sub.width > frame.width - FIELD + 0.5 || sub.y + sub.height > frame.height - FIELD + 0.5) failures.push(`${label}: the submenu does not keep the shadow's field inside the frame`);
      }
      await closeMenu(page);
    }

    // The page draws a menu only once its area is the frame set for it (МО30).
    {
      const label = `${theme}, the frame`;
      const { frame } = await prepare(page, SHAPES[1]);
      await page.setViewportSize({ width: frame.width + 40, height: frame.height + 40 });
      await fire(page);
      if ((await surfaceBox(page)) !== null) failures.push(`${label}: a menu was drawn in another frame than its own`);
      await page.setViewportSize(frame);
      await page.waitForSelector("[data-menu-panel-surface]");
      const waited = await page.evaluate(() => window.__auditCommands
        .filter(({ command, args }) => command === "menu_panel_painted" && args.paint.menu === window.__auditMenu)
        .map(({ args }) => args.paint.sized_at - args.paint.received_at).at(-1) ?? null);
      console.log(`${label}: drawn once the area took the frame, ${waited === null ? "no report" : `${waited.toFixed(1)} ms after the opening was heard`}`);
      await closeMenu(page);
    }

    // The keys in the page (МО49 to МО51).
    {
      const label = `${theme}, the keys`;
      const { frame } = await prepare(page, SHAPES[1]);
      await page.setViewportSize(frame);
      await fire(page);
      // The arrows move the highlight row by row, down and up; Enter chooses
      // the lit row.
      const litRow = () => page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll("[data-menu-panel-surface] > [role='menuitem']"));
        return { index: rows.indexOf(document.activeElement), text: document.activeElement?.textContent?.trim() ?? null, rows: rows.length };
      });
      await page.keyboard.press("ArrowDown");
      const first = await litRow();
      await page.keyboard.press("ArrowDown");
      const second = await litRow();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowUp");
      const back = await litRow();
      if (first.index < 0 || second.index !== first.index + 1 || back.index !== second.index) {
        failures.push(`${label}: the arrows do not move the highlight row by row: ${JSON.stringify([first, second, back])}`);
      }
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.__auditCommands.some(({ command, args }) => command === "menu_panel_request" && args.request.menu === window.__auditMenu));
      const chosen = await requests(page);
      console.log(`${label}: arrows lit ${JSON.stringify(first.text)}, then ${JSON.stringify(second.text)}; Enter asks ${JSON.stringify(chosen)}`);
      const ids = { "Reveal in Finder": "reveal", "Copy Path": "copy-path", "Rename…": "rename", Delete: "delete" };
      if (chosen.length !== 1 || chosen[0].action?.kind !== "run" || chosen[0].action.id !== ids[back.text] || chosen[0].close !== "chosen") {
        failures.push(`${label}: Enter did not choose the lit row ${JSON.stringify(back.text)} and close the menu`);
      }
      await closeMenu(page);

      // Escape closes the menu.
      await prepare(page, SHAPES[1]);
      await fire(page);
      await page.locator("[data-menu-panel-surface]").focus();
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => window.__auditCommands.some(({ command, args }) => command === "menu_panel_request" && args.request.menu === window.__auditMenu));
      const escaped = await requests(page);
      if (escaped.length !== 1 || escaped[0].action !== null || escaped[0].close !== "escape") failures.push(`${label}: Escape did not close the menu as escaped`);
      await closeMenu(page);

      // The search field: typing filters the list in the page, the page the
      // menu came from hears nothing; Escape clears the query first, and
      // closes the menu when there is none.
      const connect = await prepare(page, SHAPES[3]);
      await page.setViewportSize(connect.frame);
      await fire(page);
      await page.waitForFunction(() => document.activeElement?.getAttribute("placeholder") === "Search collections...");
      await page.keyboard.type("Collection 07");
      const filtered = await page.evaluate(() => Array.from(document.querySelectorAll("[data-collection-picker-row]")).map((row) => row.textContent.trim()));
      if (filtered.length !== 1 || !filtered[0].startsWith("Collection 07")) failures.push(`${label}: typing did not filter the list to one row: ${JSON.stringify(filtered)}`);
      if ((await requests(page)).length !== 0) failures.push(`${label}: typing in the search field asked the backend`);
      await page.keyboard.press("Escape");
      const afterFirst = await page.evaluate(() => ({ value: document.activeElement?.value, rows: document.querySelectorAll("[data-collection-picker-row]").length }));
      if (afterFirst.value !== "" || afterFirst.rows < 8) failures.push(`${label}: Escape with a query did not clear the query`);
      if ((await requests(page)).length !== 0) failures.push(`${label}: Escape with a query closed the menu`);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => window.__auditCommands.some(({ command, args }) => command === "menu_panel_request" && args.request.menu === window.__auditMenu));
      const closed = await requests(page);
      console.log(`${label}: typing left ${JSON.stringify(filtered)}; Escape cleared the query, then asked ${JSON.stringify(closed)}`);
      if (closed.length !== 1 || closed[0].close !== "escape") failures.push(`${label}: Escape with no query did not close the menu`);
      await closeMenu(page);
    }
    // What comes of a choice shows in the menu, and the menu keeps its
    // frame (МО24, МО28, МО29).
    {
      const label = `${theme}, a menu that stays open`;
      const shapeOf = (kind) => SHAPES.find((shape) => shape.kind === kind);
      const asked = () => page.waitForFunction(() => window.__auditCommands.some(({ command, args }) => command === "menu_panel_request" && args.request.menu === window.__auditMenu));

      // A new card that could not be made: the words stand under the list,
      // and the list gives them its rows.
      const picker = await prepare(page, shapeOf("new-card"));
      await page.setViewportSize(picker.frame);
      await fire(page);
      const rowsShown = () => page.evaluate(() => {
        const list = document.querySelector("[data-menu-panel-surface] [data-quantized-menu-scroll-area]");
        return Math.round((list.getBoundingClientRect().height - 4) / 32);
      });
      const rowsBefore = await rowsShown();
      await page.locator("[data-menu-panel-surface] [role='menuitem']").first().click();
      await asked();
      const creating = await requests(page);
      if (creating.length !== 1 || creating[0].action?.action?.kind !== "create_card" || creating[0].close !== null) {
        failures.push(`${label}: a choice in the picker did not ask for the card alone: ${JSON.stringify(creating)}`);
      }
      const why = "This selection cannot be mapped safely to the note. Select a smaller text fragment.";
      await page.evaluate(async (message) => {
        window.__auditFire("menu-panel-to-page", { source: "tab-audit", menu: window.__auditMenu, seq: 2, body: { kind: "answer", request: 1, answer: { kind: "failed", message } } });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, why);
      await page.waitForSelector("[data-menu-panel-surface] [role='alert']");
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const failed = await page.evaluate(() => {
        const surface = document.querySelector("[data-menu-panel-surface]").getBoundingClientRect();
        const alert = document.querySelector("[data-menu-panel-surface] [role='alert']").getBoundingClientRect();
        return { bottom: surface.bottom, height: surface.height, alert: { top: alert.top, bottom: alert.bottom, height: alert.height } };
      });
      const rowsAfter = await rowsShown();
      console.log(`${label}: the picker ${picker.size.height} px in a frame of ${picker.frame.height}; with the words of a failure ${failed.height} px, the words ${failed.alert.height} px, the list ${rowsBefore} rows, then ${rowsAfter}`);
      if (failed.bottom > picker.frame.height - FIELD + 0.5) failures.push(`${label}: the picker with the words of a failure leaves its frame`);
      if (failed.alert.bottom > failed.bottom + 0.5 || failed.alert.height < 16) failures.push(`${label}: the words of a failure are not whole inside the picker`);
      if (rowsAfter >= rowsBefore || rowsAfter < 1) failures.push(`${label}: the list did not give its rows to the words of a failure`);
      await closeMenu(page, 3);

      // Copy Media: the page the menu came from hears the choice, the menu stays.
      const media = await prepare(page, shapeOf("media"));
      await page.setViewportSize(media.frame);
      await fire(page);
      await page.locator("[data-menu-panel-surface] [role='menuitem']", { hasText: "Copy Media" }).click();
      await asked();
      const copied = await requests(page);
      const still = await surfaceBox(page);
      console.log(`${label}: Copy Media asks ${JSON.stringify(copied)}`);
      if (copied.length !== 1 || copied[0].action?.id !== "copy-media" || copied[0].close !== null) failures.push(`${label}: Copy Media closed the menu`);
      if (still === null) failures.push(`${label}: the menu is gone after Copy Media`);
      await closeMenu(page);

      // A command that cannot be chosen takes no press.
      const video = await prepare(page, shapeOf("source-video"));
      await page.setViewportSize(video.frame);
      await fire(page);
      await page.locator("[data-menu-panel-surface] [role='menuitem']", { hasText: "Download Media" }).click({ force: true });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if ((await requests(page)).length !== 0) failures.push(`${label}: a command that cannot be chosen was chosen`);
      await closeMenu(page);

      // A row's button of the list of spaces says what it does in a tooltip
      // that stays inside the panel's frame (МО27).
      const spaces = await prepare(page, SHAPES.find((shape) => shape.kind === "spaces" && shape.count === 10));
      await page.setViewportSize(spaces.frame);
      await fire(page);
      const lastRow = page.locator("[data-menu-panel-surface] [data-vault-switcher-row]").nth(7);
      await lastRow.hover();
      const remove = lastRow.locator("button[aria-label^='Remove']");
      await remove.hover();
      await page.waitForSelector("[data-slot='tooltip-content']");
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const tooltip = await page.evaluate(() => {
        const box = document.querySelector("[data-slot='tooltip-content']").getBoundingClientRect();
        return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, text: document.querySelector("[data-slot='tooltip-content']").textContent };
      });
      console.log(`${label}: a row's tooltip ${JSON.stringify(tooltip)} in a frame of ${spaces.frame.width}x${spaces.frame.height}`);
      if (!tooltip.text.includes("Remove from the list")) failures.push(`${label}: the tooltip does not say what the button does`);
      if (tooltip.x < 0 || tooltip.y < 0 || tooltip.right > spaces.frame.width + 0.5 || tooltip.bottom > spaces.frame.height + 0.5) {
        failures.push(`${label}: a row's tooltip leaves the panel's frame`);
      }
      await remove.click();
      await asked();
      const forgotten = await requests(page);
      if (forgotten.length !== 1 || forgotten[0].action?.action?.kind !== "forget_space" || forgotten[0].close !== "chosen") {
        failures.push(`${label}: the button did not ask to forget the space and close the menu: ${JSON.stringify(forgotten)}`);
      }
      await closeMenu(page);

      // A choice of the Display panel: the page the menu came from hears it,
      // the menu stays, and the tick moves with the next description.
      const display = await prepare(page, shapeOf("display-feed"));
      await page.setViewportSize(display.frame);
      await fire(page);
      const ticked = () => page.evaluate(() => Array.from(document.querySelectorAll("[data-menu-panel-surface] [role='menuitemradio'][aria-checked='true']")).map((row) => row.textContent.trim()));
      const tickedBefore = await ticked();
      await page.locator("[data-menu-panel-surface] [role='menuitemradio']", { hasText: "Oldest first" }).click();
      await asked();
      const chosen = await requests(page);
      if (chosen.length !== 1 || chosen[0].action?.kind !== "choose" || chosen[0].action.id !== "sort" || chosen[0].action.value !== "Oldest first" || chosen[0].close !== null) {
        failures.push(`${label}: a choice of the Display panel did not ask for the value alone: ${JSON.stringify(chosen)}`);
      }
      await page.evaluate(async () => {
        const next = JSON.parse(JSON.stringify(window.__auditOpening.body.spec));
        next.entries.find((entry) => entry.id === "sort").value = "Oldest first";
        window.__auditFire("menu-panel-to-page", { source: "tab-audit", menu: window.__auditMenu, seq: 2, body: { kind: "update", spec: next } });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      const tickedAfter = await ticked();
      const displayBox = await surfaceBox(page);
      console.log(`${label}: the Display panel ticked ${JSON.stringify(tickedBefore)}, then ${JSON.stringify(tickedAfter)}`);
      if (tickedBefore[0] !== "Newest first" || tickedAfter[0] !== "Oldest first" || tickedAfter.length !== tickedBefore.length) failures.push(`${label}: the tick did not move with the next description`);
      if (displayBox === null || Math.abs(displayBox.height - display.size.height) > 0.5) failures.push(`${label}: the Display panel changed its size with a choice`);
      await closeMenu(page, 3);
    }
    assert.deepEqual(errors, [], `${theme}: page errors`);
    await page.close();
  }
} finally {
  await browser?.close();
  await vite.close();
}
if (failures.length > 0) {
  console.error(`Menu panel audit failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("Menu panel audit passed: the page is clear at rest; every menu is opaque with its shadow whole inside its frame, its size as its description counts, its submenu inside the frame; a menu waits for its frame; the keys work; a menu that stays open keeps its frame.");
