// The Connected / Disconnect / Connect button of a sidebar row in headless
// Chromium: 8px from the row on all four sides and one width in every state,
// at 1x and 2x. Starts and stops its own Vite.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { COLD_START_MS, startAuditVite } from "./audit-vite.mjs";

const entry = "/sidebar-action-audit-entry.js";
const route = "/__sidebar-action-audit";
const INSET_PX = 8;

const vite = await startAuditVite([{
  name: "sidebar-action-audit",
  resolveId(id) { if (id === entry) return `\0${entry}`; },
  load(id) {
    if (id !== `\0${entry}`) return;
    return `import React from "react";
      import {createRoot} from "react-dom/client";
      import {MemoryRouter} from "react-router";
      import {DndContext} from "@dnd-kit/core";
      import {Sidebar} from "/src/components/Sidebar.tsx";
      import {TooltipProvider} from "/src/components/ui/tooltip.tsx";
      import "/src/styles/global.css";
      const noop=()=>{};
      function Fixture(){
        const [linked,setLinked]=React.useState(true);
        return React.createElement(MemoryRouter,null,React.createElement(TooltipProvider,null,
          React.createElement(DndContext,null,React.createElement(Sidebar,{
            width:600,collapsed:false,isResizing:false,orderedTags:[{tag:"alpha",count:18}],
            channelPreviews:new Map(),totalBlocks:18,isDropDragging:false,isCreatingChannel:false,
            onSetCreatingChannel:noop,onDeleteTag:noop,onRenameTag:noop,onCreateChannel:noop,
            linkedBlockSlug:"audit",linkedTags:linked?["alpha"]:[],onToggleLinkedTag:()=>setLinked(!linked)
          }))));
      }
      createRoot(document.getElementById("root")).render(React.createElement(Fixture));`;
  },
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url !== route) return next();
      res.setHeader("Content-Type", "text/html");
      res.end(await server.transformIndexHtml(req.url, `<html><body><div id="root" style="--sidebar-width:600px;height:600px"></div><script type="module" src="${entry}"></script></body></html>`));
    });
  },
}]);

/** The label the button shows: of its stacked labels, the one fully shown;
 *  nothing while the button itself is not fully shown. */
function shownLabel(button) {
  if (getComputedStyle(button).opacity !== "1") return "";
  const stack = button.firstElementChild;
  if (!stack) return button.textContent.trim();
  return [...stack.children]
    .filter((label) => getComputedStyle(label).opacity === "1")
    .map((label) => label.textContent.trim())
    .join(" + ");
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const scale of [1, 2]) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: scale });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript({ content: `window.shownLabel = ${shownLabel.toString()};` });
    await page.goto(new URL(route, vite.origin).href);
    const button = page.getByRole("button", { name: /^(Disconnect|Connect) alpha$/ });
    await button.waitFor({ timeout: COLD_START_MS });
    let previous;
    for (const state of ["Connected", "Disconnect", "Connect"]) {
      if (state === "Connected") await page.mouse.move(900, 650);
      else await button.hover();
      if (state === "Connect") await button.click();
      const handle = await button.elementHandle();
      await page.waitForFunction(([element, expected]) => window.shownLabel(element) === expected, [handle, state]);
      const rect = await button.evaluate((el) => {
        const r = el.getBoundingClientRect(), row = el.closest("[data-sidebar-row]").getBoundingClientRect();
        const zone = parseFloat(getComputedStyle(el).getPropertyValue("--sidebar-zone"));
        return { width: r.width, left: r.left - (row.right - zone), right: row.right - r.right, top: r.top - row.top, bottom: row.bottom - r.bottom };
      });
      for (const edge of ["left", "right", "top", "bottom"]) assert.equal(rect[edge], INSET_PX, `${scale}x ${state} ${edge}`);
      if (previous) assert.equal(rect.width, previous.width, `${scale}x ${state} width`);
      previous = rect;
      console.log(`PASS ${scale}x ${state}: ${INSET_PX}px on all four sides`);
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser?.close();
  await vite.close();
}
