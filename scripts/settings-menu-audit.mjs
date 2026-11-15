import assert from "node:assert/strict";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { COLD_START_MS, startAuditVite } from "./audit-vite.mjs";

// Render the production component/CSS without a vault, Tauri, or user profile.
// The audit's own Vite: a free port and a cache of its own (audit-vite.mjs).
const entry = "/settings-menu-audit-entry.js";
const route = "/__settings-menu-audit";
const vite = await startAuditVite([{
    name: "settings-menu-audit",
    resolveId(id) { if (id === entry) return `\0${entry}`; },
    load(id) {
      if (id !== `\0${entry}`) return;
      return `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { AppSettingsMenu } from "/src/components/AppSettingsMenu.tsx";
        import { TopCollectionSwitcher } from "/src/components/TopCollectionSwitcher.tsx";
        import { MainSecondaryTopBar } from "/src/components/MainSecondaryChrome.tsx";
        import { ActionButton } from "/src/components/ActionButton.tsx";
        import { ChromeRow, ChromeShell } from "/src/components/ChromeRow.tsx";
        import { installMotionLevel } from "/src/lib/motion.ts";
        import "/src/styles/global.css";
        // The level the page stored before it loaded: Off, so the menus land
        // at once for the geometry (SPEC_MOTION_LEVELS.md, «Тесты»).
        installMotionLevel();
        const noop = () => {};
        // Menu focus/drag hooks emit application events; no native shell exists
        // in this isolated geometry fixture. Menu content also reads its card.
        // Reject all other IPC explicitly.
        window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, invoke: async command => {
          if (command === "plugin:event|emit" || command === "plugin:event|emit_to") return;
          if (command === "get_block") return { slug: "audit", content: "Text", tags: [] };
          if (command === "start_window_drag") { window.dragCount = (window.dragCount || 0) + 1; return; }
          throw new Error("Unexpected fixture IPC: " + command);
        }};
        const secondaryProps = {
          detailBlock: null, viewMode: "grid", onViewModeChange: noop, vaultPath: "/audit", tags: [],
          onToggleTag: noop, onCreateAndAssign: noop, onRequestRename: noop,
          onRenameFile: async () => undefined, onCheckFileName: async () => null,
          onRequestDelete: noop, onDetailClose: noop, detailMenuOpenRequestSequence: 0,
        };
        // The app's layout: the half over the feed stands in the top row after
        // the collection switcher, with no row of its own (DESIGN_SYSTEM.md,
        // «Верхние ряды»).
        // The sidebar's width as useSidebarResize writes it (sidebarWidth.ts).
        document.documentElement.style.setProperty("--sidebar-width", "300px");
        function Fixture() {
          const [detail, setDetail] = React.useState(false);
          window.setDetail = setDetail;
          const block = { id: 1, slug: "audit", block_type: "article", card_kind: "article", display_title: "Audit", fallback_label: "Audit", saved_at: "2026-09-18T00:00:00Z", body: "Text", url: null, media_urls: null, author: null };
          const props = { ...secondaryProps, detailBlock: detail ? block : null, detailEntered: detail, onDetailClose: () => { window.closeCount = (window.closeCount || 0) + 1; } };
          return React.createElement(ChromeShell, null,
          React.createElement(ChromeRow, { as: "header", separator: "bottom", className: "bg-chrome" },
            React.createElement(TopCollectionSwitcher, { onRename: async () => undefined, joinsNext: true }),
            React.createElement(MainSecondaryTopBar, props),
            React.createElement(AppSettingsMenu, { onSelectSection: id => { window.selectedSection = id; } })
          ),
          React.createElement("main", { className: "flex-1 min-h-0" }),
          React.createElement(ChromeRow, { separator: "top", className: "bg-accent px-4", "data-bottom-action-bar": "" },
            React.createElement(ActionButton, { chrome: true, hotkey: "⌘F", onClick: () => { window.actionCount = (window.actionCount || 0) + 1; } }, "Search")
          ));
        }
        createRoot(document.getElementById("root")).render(React.createElement(Fixture));`;
    },
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url !== route) return next();
        try {
          const html = await vite.transformIndexHtml(route,
            `<!doctype html><html><head></head><body class="bg-background"><div id="root"></div><script type="module" src="${entry}"></script></body></html>`);
          res.setHeader("Content-Type", "text/html");
          res.end(html);
        } catch (error) { next(error); }
      });
    },
  }]);

// The top rows, closed by a line below, step as a sidebar table row: 39px of
// content and the 1px line; the bottom bar keeps 30px (SPEC_TABS.md, В83).
// Every control's plate is 24px, centred in its row (DESIGN_SYSTEM.md,
// «Иконочные кнопки хрома»).
const TOP_ROW_HEIGHT = 39;
const BOTTOM_ROW_HEIGHT = 30;
const PLATE_HEIGHT = 24;
/** The gaps above and below each top-row plate as drawn, for the report. */
const renderedGaps = new Map();
const rowHeightOf = selector => selector.startsWith("[data-bottom-action-bar]") ? BOTTOM_ROW_HEIGHT : TOP_ROW_HEIGHT;

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    channel: process.env.MINE_AUDIT_BROWSER_CHANNEL,
    executablePath: process.env.MINE_AUDIT_BROWSER_EXECUTABLE,
  });
  const errors = [];
  const url = new URL(route, vite.origin).href;
  const colors = new Map();
  for (const deviceScaleFactor of [1, 2]) {
  const page = await browser.newPage({ deviceScaleFactor });
  // The menus land at once at Off, the level the person can choose, rather
  // than by a style of the audit's own (SPEC_MOTION_LEVELS.md, «Тесты»).
  await page.addInitScript(() => window.localStorage.setItem("mine.motion", "off"));
  page.setDefaultNavigationTimeout(COLD_START_MS);
  page.on("pageerror", error => errors.push(error.message));
  for (const width of [904, 1200]) {
    await page.setViewportSize({ width, height: 600 });
    await page.goto(url, { waitUntil: "networkidle" });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.motion), "off");
    const trigger = page.getByRole("button", { name: "Mine settings" });
    await trigger.waitFor();
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.locator('[data-bottom-action-bar]').waitFor();
      await page.mouse.move(0, 300);
      // Measure the complete hover plate against actual rendered boundaries,
      // including the shared line between rows and the shell's outer edges.
      // The bottom bar's action is the standard Button frame, which has no
      // chrome plate (DESIGN_SYSTEM.md, «ActionButton: действующее
      // представление»); its frame is measured after the plates.
      const plates = [
        "[data-top-chrome-settings-menu] [data-chrome-plate]",
        "[data-main-view-mode-switcher] [data-chrome-plate]",
      ];
      for (const selector of plates) {
        const plate = page.locator(selector).first();
        await plate.locator("..").hover();
        const geometry = await plate.evaluate(element => {
          const row = element.closest(".chrome-row");
          const r = row.getBoundingClientRect();
          const p = element.getBoundingClientRect();
          const upper = row.previousElementSibling;
          const lower = row.nextElementSibling;
          const u = upper.getBoundingClientRect();
          const l = lower.getBoundingClientRect();
          return {
            rowHeight: r.height, height: p.height,
            top: p.top - u.bottom, bottom: l.top - p.bottom,
            borderTop: getComputedStyle(row).borderTopWidth,
            borderBottom: getComputedStyle(row).borderBottomWidth,
            upperIsLine: upper.matches("[data-slot=separator]"),
            lowerIsLine: lower.matches("[data-slot=separator]"),
            upperHeight: u.height, lowerHeight: l.height,
            upperJoin: r.top - u.bottom, lowerJoin: l.top - r.bottom,
            pseudo: getComputedStyle(row, "::after").content,
            sampleX: (p.left + p.right) / 2,
            upperBottom: u.bottom, plateTop: p.top,
            plateBottom: p.bottom, lowerTop: l.top,
          };
        });
        const rowHeight = rowHeightOf(selector);
        const gap = (rowHeight - PLATE_HEIGHT) / 2;
        assert.equal(geometry.rowHeight, rowHeight, selector);
        assert.equal(geometry.top, geometry.bottom, `${selector}: symmetric hover`);
        assert.equal(geometry.borderTop, "0px");
        assert.equal(geometry.borderBottom, "0px");
        assert.ok(geometry.upperIsLine && geometry.lowerIsLine, selector);
        assert.equal(geometry.upperHeight, 1);
        assert.equal(geometry.lowerHeight, 1);
        assert.equal(geometry.upperJoin, 0);
        assert.equal(geometry.lowerJoin, 0);
        assert.equal(geometry.pseudo, "none");
        assert.equal(geometry.height, PLATE_HEIGHT);
        assert.equal(geometry.top, gap, selector);
        assert.equal(geometry.bottom, gap, selector);
        if (theme === "dark" && width === 1200 && deviceScaleFactor === 2) {
          const pixels = PNG.sync.read(await page.screenshot({ path: `/private/tmp/mine-chrome-hover-${plates.indexOf(selector)}.png`, animations: "disabled" }));
          const x = Math.floor(geometry.sampleX * deviceScaleFactor);
          const rgb = y => {
            const offset = (y * pixels.width + x) * 4;
            return [...pixels.data.subarray(offset, offset + 3)];
          };
          // The rendered column between the two lines: background, the plate,
          // background. A 7.5px gap is a half pixel the renderer snaps when it
          // paints, so the gaps as drawn may differ by one CSS pixel and
          // together keep the row's free height; each is the row's background,
          // with nothing else drawn in it.
          const first = Math.round(geometry.upperBottom * deviceScaleFactor);
          const end = Math.round(geometry.lowerTop * deviceScaleFactor);
          const column = Array.from({ length: end - first }, (_, i) => rgb(first + i));
          const background = column[0].join();
          const plateStart = column.findIndex(pixel => pixel.join() !== background);
          const plateEnd = column.length - [...column].reverse().findIndex(pixel => pixel.join() !== background);
          const above = column.slice(0, plateStart);
          const below = column.slice(plateEnd);
          assert.equal(plateEnd - plateStart, PLATE_HEIGHT * deviceScaleFactor, `${selector}: rendered plate height`);
          assert.equal(above.length + below.length, 2 * gap * deviceScaleFactor, `${selector}: rendered free height`);
          assert.ok(Math.abs(above.length - below.length) <= deviceScaleFactor, `${selector}: rendered gaps ${above.length}/${below.length} device px`);
          assert.ok([...above, ...below].every(pixel => pixel.join() === background), `${selector}: rendered background gaps`);
          assert.notDeepEqual(rgb(first - 1), column[0]);
          assert.notDeepEqual(rgb(end), column[0]);
          renderedGaps.set(selector, [above.length / deviceScaleFactor, below.length / deviceScaleFactor]);
        }
      }
      // An element of another height keeps the same centring in its row
      // (DESIGN_SYSTEM.md, «Все chrome-строки используют один ChromeRow»).
      const actionFrame = await page.locator('[data-bottom-action-bar] [data-action-button="standard"] > span').first().evaluate(element => {
        const row = element.closest(".chrome-row").getBoundingClientRect();
        const frame = element.getBoundingClientRect();
        return { rowHeight: row.height, top: frame.top - row.top, bottom: row.bottom - frame.bottom };
      });
      assert.equal(actionFrame.rowHeight, BOTTOM_ROW_HEIGHT, "bottom bar row");
      assert.equal(actionFrame.top, actionFrame.bottom, "bottom bar action frame centred");
      assert.equal(await page.locator("[data-slot=separator] + [data-slot=separator]").count(), 0);
      const edgeGeometry = await page.locator("[data-chrome-shell]").evaluate(shell => ({
        top: shell.firstElementChild.getBoundingClientRect().top,
        bottom: shell.lastElementChild.getBoundingClientRect().bottom,
      }));
      assert.deepEqual(edgeGeometry, { top: 0, bottom: 600 });
      await page.screenshot({ path: `/private/tmp/mine-chrome-${theme}-${width}-${deviceScaleFactor}x.png`, animations: "disabled" });
      await page.mouse.move(0, 300);
      // Radix hides the trigger from the accessibility tree while the menu
      // is open; measure its actual DOM geometry in both states.
      const readGeometry = () => page.locator("[data-top-chrome-settings-menu] button").evaluate(button => {
        const logo = button.querySelector("svg");
        const path = logo.querySelector("path");
        const ink = path.getBoundingClientRect();
        return {
          rightInset: innerWidth - ink.right,
          inkWidth: ink.width,
          buttonWidth: button.getBoundingClientRect().width,
          svgWidth: logo.getBoundingClientRect().width,
          svgInset: innerWidth - logo.getBoundingClientRect().right,
          buttonColor: getComputedStyle(button).color,
          fill: getComputedStyle(path).fill,
          foreground: getComputedStyle(logo).color,
          // A highlight is a state layer, painted as a background image over
          // the plate's own fill (global.css, `state-active`).
          background: getComputedStyle(button.querySelector('[data-chrome-plate]')).backgroundColor,
          layer: getComputedStyle(button.querySelector('[data-chrome-plate]')).backgroundImage,
          tileCount: button.querySelectorAll("img, image, rect").length,
        };
      });
      const rest = await readGeometry();
      // The plate stands 8px from the window's edge and centres the mark's
      // 12x8px box; the 12x7.5px mark spans the box's width (DESIGN_SYSTEM.md,
      // «Кнопка логотипа», 07.10.2026; MineLogo.tsx).
      assert.equal(rest.svgInset, 14, `${theme}/${width}: icon canvas inset`);
      assert.equal(rest.svgWidth, 12);
      assert(Math.abs(rest.rightInset - 14) < 0.05);
      assert(Math.abs(rest.inkWidth - 12) < 0.05);
      assert.equal(rest.buttonWidth, 24);
      assert.equal(rest.tileCount, 0);
      assert.equal(rest.fill, rest.foreground);
      assert.equal(rest.foreground, rest.buttonColor);
      assert.equal(rest.background, "rgba(0, 0, 0, 0)");
      assert.equal(rest.layer, "none");
      colors.set(theme, rest.fill);
      await trigger.hover();
      const hover = await readGeometry();
      assert.equal(hover.foreground, hover.buttonColor);
      assert.notEqual(hover.foreground, rest.foreground);
      assert.equal(hover.rightInset, rest.rightInset);
      assert.equal(hover.inkWidth, rest.inkWidth);
      assert.notEqual(hover.layer, rest.layer);
      await trigger.click();
      // The settings window's sections, Design system gone since 07.10.2026
      // (SPEC_SETTINGS_WINDOW.md; src/lib/settingsSections.ts).
      assert.equal(await page.getByRole("menuitem").count(), 7);
      const menu = await page.getByRole("menu").boundingBox();
      assert.ok(menu.x >= 0 && menu.x + menu.width <= width);
      assert.equal((await readGeometry()).rightInset, rest.rightInset);
      await page.screenshot({ path: `/private/tmp/mine-settings-menu-${theme}-${width}.png`, animations: "disabled" });
      await page.evaluate(() => { window.selectedSection = undefined; });
      await page.getByRole("menuitem", { name: "New files" }).click();
      // A chosen item blinks once on every level, Off included, and its
      // command runs after the blink (SPEC_MOTION_LEVELS.md, РД5; menuBlink.ts).
      await page.waitForFunction(() => window.selectedSection !== undefined);
      assert.equal(await page.evaluate(() => window.selectedSection), "layout");
      await page.getByRole('menu').waitFor({ state: 'hidden' });
      // Every dropdown opens 4px from its button's visible plate, whatever
      // the height of the row (DESIGN_SYSTEM.md, «Отступ от кнопки»,
      // 11.10.2026).
      const gaps = [];
      for (const selector of ['[data-top-chrome-settings-menu] button']) {
        const target = page.locator(selector);
        const box = await target.boundingBox();
        assert.equal(box.height, TOP_ROW_HEIGHT);
        // Click the formerly dead top strip, not the visible plate.
        await page.mouse.click(box.x + box.width / 2, box.y + 1);
        await page.getByRole('menu').waitFor();
        // At Off the menu's entrance lasts 0.01ms, yet its first frame is the
        // entrance's start (global.css, `[data-motion="off"]`): measure where
        // it lands.
        await page.getByRole('menu').evaluate(async menu => {
          await Promise.all(menu.getAnimations({ subtree: true }).map(animation => animation.finished));
        });
        gaps.push(await page.locator(selector).evaluate(button => {
          const plate = button.querySelector('[data-chrome-plate]').getBoundingClientRect();
          return document.querySelector('[role="menu"]').getBoundingClientRect().top - plate.bottom;
        }));
        await page.keyboard.press('Escape');
        await page.getByRole('menu').waitFor({ state: 'hidden' });
        // Let Radix complete close-auto-focus before testing another control.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      // In a 39px row the 24px plate stands 7.5px down, on a half pixel; the
      // menu's position is rounded to a device pixel, so at 1x the gap is
      // 4px give or take half a pixel, and at 2x exactly 4px.
      assert.equal(gaps.length, 1);
      assert.ok(Math.abs(gaps[0] - 4) <= (deviceScaleFactor === 1 ? 0.5 : 0), `settings menu gap from its plate: ${gaps[0]}`);
      // All controls stay within the row, and extending vertically does not
      // change horizontal placement or create overlapping targets.
      const targets = await page.locator('[data-chrome-control]').evaluateAll(nodes => nodes.map(node => {
        const b = node.getBoundingClientRect();
        const row = node.closest('.chrome-row').getBoundingClientRect();
        return { height: b.height, rowHeight: row.height, top: b.top - row.top, bottom: row.bottom - b.bottom, x: b.x, y: b.y, right: b.right };
      }));
      assert(targets.every(t => t.height === t.rowHeight && t.top === 0 && t.bottom === 0));
      assert(targets.every(t => t.rowHeight === TOP_ROW_HEIGHT || t.rowHeight === BOTTOM_ROW_HEIGHT));
      for (let i = 0; i < targets.length; i++) for (let j = i + 1; j < targets.length; j++) {
        const a = targets[i], b = targets[j];
        if (a.y === b.y) assert(a.right <= b.x || b.right <= a.x, 'targets must not overlap');
      }
      // The bottom bar has the standard presentation only (DESIGN_SYSTEM.md,
      // «ActionButton: действующее представление»).
      {
        const action = page.locator('[data-bottom-action-bar] [role="button"]');
        await page.locator('[data-action-button="standard"]').waitFor();
        const box = await action.boundingBox();
        assert.equal(box.height, BOTTOM_ROW_HEIGHT);
        const count = await page.evaluate(() => window.actionCount || 0);
        await page.mouse.click(box.x + box.width / 2, box.y + 1);
        assert.equal(await page.evaluate(() => window.actionCount), count + 1);
        await action.press('Enter');
        assert.equal(await page.evaluate(() => window.actionCount), count + 2);
      }
      console.log(`PASS ${theme} ${width}px ${deviceScaleFactor}x: top-row plates centred 7.5px, bottom-bar frame centred, logo box inset 14px, padded logo inherits button colors, menu navigation`);
    }
  }
  await page.evaluate(() => window.setDetail(true));
  const actions = page.locator('[data-secondary-detail-top-menu]');
  // The open card's close is the chrome's one close button (ChromeCloseButton.tsx).
  await actions.getByRole('button', { name: 'Close', exact: true }).waitFor();
  await page.waitForTimeout(450);
  const geometry = await actions.evaluate(element => {
    const more = element.querySelector('[aria-label="Card actions"]').getBoundingClientRect();
    const close = element.querySelector('[aria-label="Close"]').getBoundingClientRect();
    const logo = document.querySelector('[aria-label="Mine settings"]').getBoundingClientRect();
    const row = element.closest('.chrome-row').getBoundingClientRect();
    return { more: [more.width, more.height], close: [close.width, close.height], gap: close.left - more.right, top: close.top - row.top, bottom: row.bottom - close.bottom, logoGap: logo.left - close.right };
  });
  assert.deepEqual(geometry.more, [24, TOP_ROW_HEIGHT]);
  assert.deepEqual(geometry.close, [24, TOP_ROW_HEIGHT]);
  assert.equal(geometry.gap, 4);
  assert.equal(geometry.top, 0);
  assert.equal(geometry.bottom, 0);
  // The card's actions and the logo share the top row and do not overlap.
  assert.ok(geometry.logoGap >= 0);
  await actions.getByRole('button', { name: 'Card actions' }).click();
  await page.getByRole('menu').waitFor();
  await page.keyboard.press('Escape');
  await actions.getByRole('button', { name: 'Close', exact: true }).click();
  await page.screenshot({ path: `/private/tmp/mine-detail-chrome-${deviceScaleFactor}x.png`, animations: 'disabled' });
  console.log(`PASS detail ${deviceScaleFactor}x: 24x39px targets, 4px gap, menu and close`);
  assert.equal(await page.evaluate(() => window.closeCount), 1);
  await page.close();
  }
  assert.notEqual(colors.get("light"), colors.get("dark"));
  for (const [selector, [above, below]] of renderedGaps) console.log(`Rendered at 2x: ${selector} ${above}px above, ${below}px below`);
  assert.deepEqual(errors, []);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await vite.close();
}
