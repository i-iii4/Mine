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
        import { MainSecondaryTopBar } from "/src/components/MainSecondaryChrome.tsx";
        import { ActionButton } from "/src/components/ActionButton.tsx";
        import { ChromeRow, ChromeShell } from "/src/components/ChromeRow.tsx";
        import "/src/styles/global.css";
        const noop = () => {};
        const secondaryProps = {
          sidebarCollapsed: false, sidebarResizing: false, stats: null,
          detailBlock: null, detailLinkMode: "all", onDetailLinkModeChange: noop,
          viewMode: "grid", onViewModeChange: noop, vaultPath: "/audit", tags: [],
          onToggleTag: noop, onCreateAndAssign: noop, onRequestRename: noop,
          onRequestDelete: noop, onDetailClose: noop, detailMenuOpenRequestSequence: 0,
        };
        function Fixture() {
          const [bottomMetadata, setBottomMetadata] = React.useState(false);
          window.setBottomMetadata = setBottomMetadata;
          return React.createElement(ChromeShell, { style: { "--sidebar-width": "300px" } },
          React.createElement(ChromeRow, { as: "header", separator: "bottom", className: "bg-chrome" },
            React.createElement("div", { className: "flex-1" }),
            React.createElement(AppSettingsMenu, { onSelectSection: id => { window.selectedSection = id; } })
          ),
          !bottomMetadata && React.createElement(MainSecondaryTopBar, { ...secondaryProps, placement: "top" }),
          React.createElement("main", { className: "flex-1 min-h-0" }),
          bottomMetadata ? React.createElement(MainSecondaryTopBar, { ...secondaryProps, placement: "bottom" }) :
          React.createElement(ChromeRow, { separator: "top", className: "bg-accent px-4", "data-bottom-action-bar": "" },
            React.createElement(ActionButton, { hotkey: "⌘F", onClick: noop }, "Search")
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
        "[data-top-chrome-settings-menu] button > span",
        '[data-main-secondary-top-bar] [data-main-view-mode-switcher] [role="group"]',
        ...(!bottomMetadata ? ["[data-bottom-action-bar] [data-action-button]"] : []),
      ];
      for (const selector of plates) {
        const plate = page.locator(selector).first();
        await plate.hover();
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
          fill: getComputedStyle(path).fill,
          foreground: getComputedStyle(logo).color,
          background: getComputedStyle(button.firstElementChild).backgroundColor,
          tileCount: button.querySelectorAll("img, image, rect").length,
        };
      });
      const rest = await readGeometry();
      assert.equal(rest.rightInset, 16, `${theme}/${width}: visible logo inset`);
      assert.equal(rest.inkWidth, 16);
      assert.equal(rest.buttonWidth, 32);
      assert.equal(rest.tileCount, 0);
      assert.equal(rest.fill, rest.foreground);
      assert.equal(rest.background, "rgba(0, 0, 0, 0)");
      colors.set(theme, rest.fill);
      await trigger.hover();
      const hover = await readGeometry();
      assert.equal(hover.rightInset, rest.rightInset);
      assert.equal(hover.inkWidth, rest.inkWidth);
      assert.notEqual(hover.background, rest.background);
      await trigger.click();
      assert.equal(await page.getByRole("menuitem").count(), 8);
      const menu = await page.getByRole("menu").boundingBox();
      assert.ok(menu.x >= 0 && menu.x + menu.width <= width);
      assert.equal((await readGeometry()).rightInset, 16);
      await page.screenshot({ path: `/private/tmp/mine-settings-menu-${theme}-${width}.png`, animations: "disabled" });
      await page.getByRole("menuitem", { name: "Folders" }).click();
      assert.equal(await page.evaluate(() => window.selectedSection), "layout");
      console.log(`PASS ${theme} ${width}px ${deviceScaleFactor}x ${bottomMetadata ? "metadata" : "actions"}: all plates 3/3px from visible lines, no double seams, logo inset 16px, menu navigation`);
      }
    }
  }
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
