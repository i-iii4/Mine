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
  { name: "Connect: one collection", kind: "connect", tags: [{ tag: "Web", count: 1 }], rightClick: false },
];

/** Build the opening of `shape` in the page and keep it there: the menu's
 *  description, the sizes its page counts, and the frame and the layout the
 *  backend makes of them for a menu at the frame's corner
 *  (src-tauri/src/menu_panel/geometry.rs, `panel_frame`, `panel_anchor`). */
async function prepare(page, shape) {
  return page.evaluate(async ({ shape, FIELD }) => {
    const { cardConnectSpec, cardMenuSpec } = await import("/src/lib/cardMenuEntries.ts");
    const { menuSpecSize } = await import("/src/lib/menuSpec.ts");
    const picker = { card: "card", selected: ["Web"], tags: shape.tags, currentTag: "Web" };
    const spec = shape.kind === "connect"
      ? cardConnectSpec(picker)
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
    const anchor = shape.rightClick
      ? { anchor: { x: menu.x - 4, y: menu.y }, side: "right", align: "start" }
      : { anchor: { x: menu.x + menu.width, y: menu.y - 4 }, side: "bottom", align: "end" };
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

/** The backend closes the menu the page draws. */
async function closeMenu(page) {
  await page.evaluate(async () => {
    window.__auditFire("menu-panel-to-page", { source: "tab-audit", menu: window.__auditMenu, seq: 2, body: { kind: "closed", reason: "outside" } });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
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
      const lower = shape.kind === "connect" && shape.tags.length < 8;
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
        await page.locator("[data-menu-panel-surface] [role='menuitem']").first().focus();
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
        if (shape.tags.length >= 8 ? Math.abs(sub.height - counted.height) > 0.5 : sub.height > counted.height + 0.5) failures.push(`${label}: the submenu is not the height its description counts`);
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
console.log("Menu panel audit passed: the page is clear at rest; every menu is opaque with its shadow whole inside its frame, its size as its description counts, its submenu inside the frame; a menu waits for its frame; the keys work.");
