import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import { PNG } from "pngjs";

// Render the production component/CSS without a vault, Tauri, or user profile.
const entry = "/settings-menu-audit-entry.js";
const route = "/__settings-menu-audit";
const server = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, open: false },
  plugins: [{
    name: "settings-menu-audit",
    resolveId(id) { if (id === entry) return `\0${entry}`; },
    load(id) {
      if (id !== `\0${entry}`) return;
      return `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { AppSettingsMenu } from "/src/components/AppSettingsMenu.tsx";
        import { TopCollectionSwitcher } from "/src/components/TopCollectionSwitcher.tsx";
        import { ActivityIndicators } from "/src/components/ActivityIndicators.tsx";
        import { applyActionButtonStyle } from "/src/lib/actionButtonStyle.ts";
        import { MainSecondaryTopBar, CompactDetailTopMenu } from "/src/components/MainSecondaryChrome.tsx";
        import { ActionButton } from "/src/components/ActionButton.tsx";
        import { ChromeRow, ChromeShell } from "/src/components/ChromeRow.tsx";
        import "/src/styles/global.css";
        const noop = () => {};
        // Menu focus/drag hooks emit application events; no native shell exists
        // in this isolated geometry fixture. Menu content also reads its card.
        // Reject all other IPC explicitly.
        window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, invoke: async command => {
          if (command === "plugin:event|emit" || command === "plugin:event|emit_to") return;
          if (command === "get_block") return { slug: "audit", content: "Text", tags: [] };
          if (command === "plugin:window|start_dragging") { window.dragCount = (window.dragCount || 0) + 1; return; }
          throw new Error("Unexpected fixture IPC: " + command);
        }};
        const secondaryProps = {
          sidebarCollapsed: false, sidebarResizing: false, stats: null,
          detailBlock: null, detailLinkMode: "all", onDetailLinkModeChange: noop,
          viewMode: "grid", onViewModeChange: noop, vaultPath: "/audit", tags: [],
          onToggleTag: noop, onCreateAndAssign: noop, onRequestRename: noop,
          onRequestDelete: noop, onDetailClose: noop, detailMenuOpenRequestSequence: 0,
        };
        function Fixture() {
          const [bottomMetadata, setBottomMetadata] = React.useState(false);
          const [detail, setDetail] = React.useState(false);
          window.setBottomMetadata = setBottomMetadata;
          window.setDetail = setDetail;
          window.setActionStyle = applyActionButtonStyle;
          const block = { id: 1, slug: "audit", block_type: "article", card_kind: "article", display_title: "Audit", fallback_label: "Audit", saved_at: "2026-09-18T00:00:00Z", body: "Text", url: null, media_urls: null, author: null };
          const props = { ...secondaryProps, detailBlock: detail ? block : null, detailEntered: detail, detailTitle: "Audit", onDetailClose: () => { window.closeCount = (window.closeCount || 0) + 1; } };
          return React.createElement(ChromeShell, { style: { "--sidebar-width": "300px" } },
          React.createElement(ChromeRow, { as: "header", separator: "bottom", className: "bg-chrome" },
            React.createElement(TopCollectionSwitcher, { orderedTags: [], onNavigate: noop, onCreateCollection: noop }),
            React.createElement(ActivityIndicators, { cloudPending: 1, indexing: false }),
            React.createElement("div", { className: "flex-1" }),
            detail && bottomMetadata && React.createElement(CompactDetailTopMenu, { ...props, block, cardTitle: "Audit", onClose: props.onDetailClose, menuOpenRequestSequence: 0, entered: true }),
            React.createElement(AppSettingsMenu, { onSelectSection: id => { window.selectedSection = id; } })
          ),
          !bottomMetadata && React.createElement(MainSecondaryTopBar, { ...props, placement: "top" }),
          React.createElement("main", { className: "flex-1 min-h-0" }),
          bottomMetadata ? React.createElement(MainSecondaryTopBar, { ...props, placement: "bottom" }) :
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
  }],
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    channel: process.env.MINE_AUDIT_BROWSER_CHANNEL,
    executablePath: process.env.MINE_AUDIT_BROWSER_EXECUTABLE,
  });
  const errors = [];
  const url = new URL(route, server.resolvedUrls.local[0]).href;
  const colors = new Map();
  for (const deviceScaleFactor of [1, 2]) {
  const page = await browser.newPage({ deviceScaleFactor });
  page.on("pageerror", error => errors.push(error.message));
  for (const width of [904, 1200]) {
    await page.setViewportSize({ width, height: 600 });
    await page.goto(url, { waitUntil: "networkidle" });
    await page.addStyleTag({ content: '[data-slot="dropdown-menu-content"] { animation: none !important; }' });
    const trigger = page.getByRole("button", { name: "Mine settings" });
    await trigger.waitFor();
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      for (const bottomMetadata of [false, true]) {
      await page.evaluate(value => window.setBottomMetadata(value), bottomMetadata);
      await page.locator(bottomMetadata ? '[data-main-secondary-placement="bottom"]' : '[data-bottom-action-bar]').waitFor();
      await page.mouse.move(0, 300);
      // Measure the complete hover plate against actual rendered boundaries,
      // including the shared line between rows and the shell's outer edges.
      const plates = [
        "[data-top-chrome-settings-menu] [data-chrome-plate]",
        '[data-main-secondary-top-bar] [data-main-view-mode-switcher] [data-chrome-plate]',
        ...(!bottomMetadata ? ["[data-bottom-action-bar] [data-chrome-plate]"] : []),
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
        assert.equal(geometry.rowHeight, 30, selector);
        assert.equal(geometry.top, geometry.bottom, `${selector}: symmetric hover`);
        assert.equal(geometry.borderTop, "0px");
        assert.equal(geometry.borderBottom, "0px");
        assert.ok(geometry.upperIsLine && geometry.lowerIsLine, selector);
        assert.equal(geometry.upperHeight, 1);
        assert.equal(geometry.lowerHeight, 1);
        assert.equal(geometry.upperJoin, 0);
        assert.equal(geometry.lowerJoin, 0);
        assert.equal(geometry.pseudo, "none");
        assert.equal(geometry.height, 24);
        assert.equal(geometry.top, 3);
        assert.equal(geometry.bottom, 3);
        if (theme === "dark" && width === 1200 && deviceScaleFactor === 2 && !bottomMetadata) {
          const pixels = PNG.sync.read(await page.screenshot({ path: `/private/tmp/mine-chrome-hover-${plates.indexOf(selector)}.png`, animations: "disabled" }));
          const x = Math.floor(geometry.sampleX * deviceScaleFactor);
          const rgb = y => {
            const offset = (y * pixels.width + x) * 4;
            return [...pixels.data.subarray(offset, offset + 3)];
          };
          const band = (start, end) => Array.from({ length: (end - start) * deviceScaleFactor }, (_, i) => rgb(start * deviceScaleFactor + i));
          const above = band(geometry.upperBottom, geometry.plateTop);
          const below = band(geometry.plateBottom, geometry.lowerTop);
          assert.equal(above.length, 6);
          assert.deepEqual(above, below, `${selector}: rendered background gaps`);
          assert.ok(above.every(pixel => pixel.join() === above[0].join()));
          assert.notDeepEqual(rgb(geometry.upperBottom * deviceScaleFactor - 1), above[0]);
          assert.notDeepEqual(rgb(geometry.lowerTop * deviceScaleFactor), below[0]);
        }
      }
      assert.equal(await page.locator("[data-slot=separator] + [data-slot=separator]").count(), 0);
      const edgeGeometry = await page.locator("[data-chrome-shell]").evaluate(shell => ({
        top: shell.firstElementChild.getBoundingClientRect().top,
        bottom: shell.lastElementChild.getBoundingClientRect().bottom,
      }));
      assert.deepEqual(edgeGeometry, { top: 0, bottom: 600 });
      await page.screenshot({ path: `/private/tmp/mine-chrome-${theme}-${width}-${deviceScaleFactor}x-${bottomMetadata ? "metadata" : "actions"}.png`, animations: "disabled" });
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
          background: getComputedStyle(button.querySelector('[data-chrome-plate]')).backgroundColor,
          tileCount: button.querySelectorAll("img, image, rect").length,
        };
      });
      const rest = await readGeometry();
      assert.equal(rest.svgInset, 16, `${theme}/${width}: icon canvas inset`);
      assert.equal(rest.svgWidth, 16);
      assert(Math.abs(rest.rightInset - 17.6) < 0.05);
      assert(Math.abs(rest.inkWidth - 12.8) < 0.05);
      assert.equal(rest.buttonWidth, 24);
      assert.equal(rest.tileCount, 0);
      assert.equal(rest.fill, rest.foreground);
      assert.equal(rest.foreground, rest.buttonColor);
      assert.equal(rest.background, "rgba(0, 0, 0, 0)");
      colors.set(theme, rest.fill);
      await trigger.hover();
      const hover = await readGeometry();
      assert.equal(hover.foreground, hover.buttonColor);
      assert.notEqual(hover.foreground, rest.foreground);
      assert.equal(hover.rightInset, rest.rightInset);
      assert.equal(hover.inkWidth, rest.inkWidth);
      assert.notEqual(hover.background, rest.background);
      await trigger.click();
      assert.equal(await page.getByRole("menuitem").count(), 8);
      const menu = await page.getByRole("menu").boundingBox();
      assert.ok(menu.x >= 0 && menu.x + menu.width <= width);
      assert.equal((await readGeometry()).rightInset, rest.rightInset);
      await page.screenshot({ path: `/private/tmp/mine-settings-menu-${theme}-${width}.png`, animations: "disabled" });
      await page.getByRole("menuitem", { name: "Folders" }).click();
      assert.equal(await page.evaluate(() => window.selectedSection), "layout");
      // Regression: identical visual plates formerly anchored to 30px and
      // 24px targets, leaving 3px and 0px below the same divider.
      const gaps = [];
      for (const selector of ['[data-top-collection-switcher]', '[data-top-chrome-settings-menu] button', '[data-activity-indicator="cloud"]']) {
        const target = page.locator(selector);
        const box = await target.boundingBox();
        assert.equal(box.height, 30);
        // Click the formerly dead top strip, not the visible plate.
        await page.mouse.click(box.x + box.width / 2, box.y + 1);
        await page.getByRole('menu').waitFor();
        gaps.push(await page.locator(selector).evaluate(button => {
          const divider = button.closest('.chrome-row').nextElementSibling.getBoundingClientRect();
          return document.querySelector('[role="menu"]').getBoundingClientRect().top - divider.bottom;
        }));
        await page.keyboard.press('Escape');
        await page.getByRole('menu').waitFor({ state: 'hidden' });
        // Let Radix complete close-auto-focus before testing another control.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      assert.deepEqual(gaps, [3, 3, 3], 'collection/settings/cloud menu divider gaps');
      // All controls stay within the row, and extending vertically does not
      // change horizontal placement or create overlapping targets.
      const targets = await page.locator('[data-chrome-control]').evaluateAll(nodes => nodes.map(node => {
        const b = node.getBoundingClientRect();
        const row = node.closest('.chrome-row').getBoundingClientRect();
        return { height: b.height, top: b.top - row.top, bottom: row.bottom - b.bottom, x: b.x, y: b.y, right: b.right };
      }));
      assert(targets.every(t => t.height === 30 && t.top === 0 && t.bottom === 0));
      for (let i = 0; i < targets.length; i++) for (let j = i + 1; j < targets.length; j++) {
        const a = targets[i], b = targets[j];
        if (a.y === b.y) assert(a.right <= b.x || b.right <= a.x, 'targets must not overlap');
      }
      if (!bottomMetadata) {
        for (const style of ['pill', 'standard']) {
          await page.evaluate(style => window.setActionStyle(style), style);
          const action = page.locator('[data-bottom-action-bar] [role="button"]');
          await page.locator(`[data-action-button="${style}"]`).waitFor();
          const box = await action.boundingBox();
          assert.equal(box.height, 30);
          const count = await page.evaluate(() => window.actionCount || 0);
          await page.mouse.click(box.x + box.width / 2, box.y + 1);
          assert.equal(await page.evaluate(() => window.actionCount), count + 1);
          await action.press('Enter');
          assert.equal(await page.evaluate(() => window.actionCount), count + 2);
        }
        await page.evaluate(() => window.setActionStyle('pill'));
      }
      const collection = await page.locator('[data-top-collection-switcher]').boundingBox();
      const dragCount = await page.evaluate(() => window.dragCount || 0);
      await page.mouse.move(collection.x + collection.width / 2, collection.y + 1);
      await page.mouse.down();
      await page.mouse.move(collection.x + collection.width / 2 + 12, collection.y + 1, { steps: 3 });
      await page.mouse.up();
      assert.equal(await page.evaluate(() => window.dragCount), dragCount + 1);
      assert.equal(await page.getByRole('menu').count(), 0, 'drag must not open a menu');
      console.log(`PASS ${theme} ${width}px ${deviceScaleFactor}x ${bottomMetadata ? "metadata" : "actions"}: plates 3/3px, icon canvas inset 16px, padded logo inherits button colors, menu navigation`);
      }
    }
  }
  for (const bottom of [false, true]) {
    await page.evaluate(bottom => { window.setDetail(true); window.setBottomMetadata(bottom); }, bottom);
    const actions = page.locator(bottom ? '[data-compact-detail-top-menu]' : '[data-secondary-detail-top-menu]');
    await actions.getByRole('button', { name: 'Close detail' }).waitFor();
    await page.waitForTimeout(450);
    const geometry = await actions.evaluate(element => {
      const more = element.querySelector('[aria-label="Card actions"]').getBoundingClientRect();
      const close = element.querySelector('[aria-label="Close detail"]').getBoundingClientRect();
      const logo = document.querySelector('[aria-label="Mine settings"]').getBoundingClientRect();
      const row = element.closest('.chrome-row').getBoundingClientRect();
      return { more: [more.width, more.height], close: [close.width, close.height], gap: close.left - more.right, top: close.top - row.top, bottom: row.bottom - close.bottom, axis: close.x + close.width / 2 - logo.x - logo.width / 2, logoGap: logo.left - close.right };
    });
    assert.deepEqual(geometry.more, [24, 30]);
    assert.deepEqual(geometry.close, [24, 30]);
    assert.equal(geometry.gap, 4);
    assert.equal(geometry.top, 0);
    assert.equal(geometry.bottom, 0);
    if (bottom) assert.equal(geometry.logoGap, 4);
    else assert.equal(geometry.axis, 0);
    await actions.getByRole('button', { name: 'Card actions' }).click();
    await page.getByRole('menu').waitFor();
    await page.keyboard.press('Escape');
    await actions.getByRole('button', { name: 'Close detail' }).click();
    await page.screenshot({ path: `/private/tmp/mine-detail-chrome-${deviceScaleFactor}x-${bottom ? 'compact' : 'secondary'}.png`, animations: 'disabled' });
    console.log(`PASS detail ${deviceScaleFactor}x ${bottom ? 'compact' : 'secondary'}: 24x30px targets, 4px gap, shared axis, menu and close`);
  }
  assert.equal(await page.evaluate(() => window.closeCount), 2);
  await page.close();
  }
  assert.notEqual(colors.get("light"), colors.get("dark"));
  assert.deepEqual(errors, []);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}
