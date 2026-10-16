// The narrow window in headless Chromium (SPEC_NARROW_WINDOW.md, У1, У4 по
// У7, У12; PLAN 47.3c): the production sidebar (Sidebar, useSidebarResize,
// useSidebarOverlay, SidebarOverlay, the styles) in the page's frame, at the
// widths of the plan. Beside the feed the sidebar keeps its target until the
// feed reaches its narrowest, then squeezes to its own; below 740 px it
// leaves the row, the feed takes the window, and the sidebar lies over the
// feed when opened: the window less the 40 px strip wide, from the sidebar's top to
// the window's bottom, the space switcher in it and not in the top row, the feed under a
// blurred scrim and inert. The strip, Escape and a collection close it; the
// window widened with it open puts it beside the feed. Starts and stops its
// own Vite.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { COLD_START_MS, startAuditVite } from "./audit-vite.mjs";

const entry = "/narrow-window-audit-entry.js";
const route = "/__narrow-window-audit";
const HEIGHT = 700;
const STRIP = 40;
const TARGET = 360;

const vite = await startAuditVite([{
  name: "narrow-window-audit",
  resolveId(id) { if (id === entry) return `\0${entry}`; },
  load(id) {
    if (id !== `\0${entry}`) return;
    return `import React from "react";
      import {createRoot} from "react-dom/client";
      import {MemoryRouter, useLocation} from "react-router";
      import {DndContext, PointerSensor, useSensor, useSensors} from "@dnd-kit/core";
      import {ChromeRow, ChromeShell} from "/src/components/ChromeRow.tsx";
      import {Sidebar} from "/src/components/Sidebar.tsx";
      import {SidebarOverlay} from "/src/components/SidebarOverlay.tsx";
      import {TooltipProvider} from "/src/components/ui/tooltip.tsx";
      import {useSidebarOverlay} from "/src/hooks/useSidebarOverlay.ts";
      import {useSidebarResize} from "/src/hooks/useSidebarResize.ts";
      import {APP_MAIN_MIN_WIDTH_PX, APP_MIN_WIDTH_PX} from "/src/lib/appLayout.ts";
      import "/src/styles/global.css";
      const h=React.createElement, noop=()=>{};
      // Long enough to scroll in the window's height, beside the feed and over it.
      const tags=[{tag:"Inbox",count:3},{tag:"Posters",count:5},
        ...Array.from({length:38},(_,index)=>({tag:"Collection "+String(index+1).padStart(2,"0"),count:index+1}))];
      function FilterRow(){
        return h("div",{"data-top-chrome-space-search-group":"",className:"flex h-full min-w-0 flex-1 items-center px-2"},
          h("span",{"data-audit-space-name":""},"Audit space"));
      }
      function Fixture(){
        const beside=React.useRef(null);
        const overlay=useSidebarOverlay({tab:false,
          onWidenWhileOpen:()=>{ if(beside.current?.collapsed) beside.current.toggle(); },
          onBesideIntent:noop});
        const resize=useSidebarResize({width_px:${TARGET},collapsed:false},overlay.narrow);
        beside.current={collapsed:resize.collapsed,toggle:resize.toggleCollapsed};
        const location=useLocation();
        const shown=overlay.narrow?overlay.open:!resize.collapsed;
        const toggle=overlay.narrow?overlay.toggle:resize.toggleCollapsed;
        React.useEffect(()=>{ window.auditToggle=toggle; },[toggle]);
        const list=h(Sidebar,{width:resize.width,collapsed:resize.collapsed,widthAnimating:false,orderedTags:tags,
          channelPreviews:new Map(),totalBlocks:8,isDropDragging:false,isCreatingChannel:false,
          onSetCreatingChannel:noop,onDeleteTag:noop,onRenameTag:noop,onCreateChannel:noop,
          onNavClick:overlay.close,onScrollToTop:overlay.close});
        return h(ChromeShell,{topEdge:false,className:"relative",style:{minWidth:APP_MIN_WIDTH_PX},"data-audit-place":location.pathname},
          h(ChromeRow,{as:"header",separator:"bottom",className:"bg-chrome",inert:overlay.open},
            overlay.narrow?null:h("div",{"data-app-top-sidebar-segment":"",className:"flex h-full shrink-0 items-center overflow-hidden border-r border-sidebar-border",
              style:resize.collapsed?undefined:{width:"var(--sidebar-width)"}},h(FilterRow)),
            h("div",{"data-audit-top-row":"",className:"flex h-full min-w-0 flex-1 items-center px-2"},"Inbox")),
          h("div",{className:"relative flex min-h-0 flex-1"},
            overlay.narrow?null:list,
            h("main",{"data-audit-feed":"",className:"relative isolate min-h-0 flex-1 overflow-hidden",
              style:{minWidth:APP_MAIN_MIN_WIDTH_PX},inert:overlay.open},
              h("button",{type:"button","data-audit-feed-button":""},"A card"))),
          h(ChromeRow,{separator:"top","data-audit-bottom-bar":"",className:"bg-accent",inert:overlay.open},
            h("button",{type:"button",onClick:toggle,"data-audit-toggle":""},shown?"Hide Sidebar":"Show Sidebar")),
          overlay.narrow?h(SidebarOverlay,{open:overlay.open,onClose:overlay.close,
            header:h(ChromeRow,{separator:"bottom",className:"bg-chrome"},
              h("div",{className:"flex h-full min-w-0 flex-1 items-center overflow-hidden border-r border-sidebar-border"},h(FilterRow)))},
            list):null);
      }
      // The app's sensors: a press is a click until the pointer travels.
      function Root(){
        const sensors=useSensors(useSensor(PointerSensor,{activationConstraint:{distance:8}}));
        return h(DndContext,{sensors},h(Fixture));
      }
      createRoot(document.getElementById("root")).render(
        h(MemoryRouter,{initialEntries:["/"]},h(TooltipProvider,null,h(Root))));`;
  },
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url !== route) return next();
      res.setHeader("Content-Type", "text/html");
      res.end(await server.transformIndexHtml(req.url, `<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="${entry}"></script></body></html>`));
    });
  },
}]);

/** Where the parts of the page stand. */
function readLayout() {
  const box = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  };
  const besideAside = [...document.querySelectorAll("aside")].find((aside) => !aside.closest("[data-sidebar-overlay]"));
  const asideBox = besideAside ? besideAside.getBoundingClientRect() : null;
  const scrim = document.querySelector("[data-sidebar-overlay-scrim]");
  const panel = document.querySelector("[data-sidebar-overlay-panel]");
  return {
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    sidebarWidthVar: document.documentElement.style.getPropertyValue("--sidebar-width"),
    aside: asideBox ? { left: asideBox.left, right: asideBox.right, width: asideBox.width, bottom: asideBox.bottom } : null,
    panelAside: box("[data-sidebar-overlay] aside"),
    panelList: (() => {
      const list = document.querySelector("[data-sidebar-overlay] [data-sidebar-scroll]");
      return list ? { scrollTop: list.scrollTop, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight, bottom: list.getBoundingClientRect().bottom } : null;
    })(),
    segment: box("[data-app-top-sidebar-segment]"),
    topSpaceName: document.querySelector("header [data-audit-space-name]") !== null,
    header: box("header"),
    feed: box("[data-audit-feed]"),
    feedInert: document.querySelector("[data-audit-feed]").inert,
    headerInert: document.querySelector("header").inert,
    bottomBar: box("[data-audit-bottom-bar]"),
    bottomBarInert: document.querySelector("[data-audit-bottom-bar]").inert,
    overlay: box("[data-sidebar-overlay]"),
    overlayState: document.querySelector("[data-sidebar-overlay]")?.getAttribute("data-state") ?? null,
    panel: panel ? { ...box("[data-sidebar-overlay-panel]"), role: panel.getAttribute("role"), transform: getComputedStyle(panel).transform,
      shadow: getComputedStyle(panel).boxShadow, spaceName: panel.querySelector("[data-audit-space-name]") !== null,
      list: panel.querySelector("[data-sidebar-scroll]") !== null } : null,
    scrim: scrim ? { ...box("[data-sidebar-overlay-scrim]"), backdrop: getComputedStyle(scrim).backdropFilter,
      opacity: getComputedStyle(scrim).opacity, background: getComputedStyle(scrim).backgroundColor } : null,
    place: document.querySelector("[data-audit-place]").getAttribute("data-audit-place"),
    focusInPanel: panel ? panel.contains(document.activeElement) : false,
  };
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: HEIGHT } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(new URL(route, vite.origin).href);
  await page.locator("[data-audit-toggle]").waitFor({ timeout: COLD_START_MS });
  // The motion is checked once below; everything else lands at once.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const settle = () => page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }));
  const read = async () => { await settle(); return page.evaluate(readLayout); };
  const resize = (width) => page.setViewportSize({ width, height: HEIGHT });
  // The tab bar's button stands outside the page, never under the scrim: the
  // page's own toggle stands in for it.
  const toggle = async () => { await settle(); await page.evaluate(() => window.auditToggle()); };

  // Beside the feed (У1): the target until the feed reaches its narrowest,
  // then the sidebar squeezes to its own; the space switcher in the top row.
  // Where the sidebar beside the feed ends: the sidebar over the feed ends
  // there too (user's decision of 15.10.2026).
  let besideBottom = null;
  for (const [width, sidebar] of [[1200, 360], [750, 360], [749, 359], [740, 350]]) {
    await resize(width);
    const layout = await read();
    besideBottom ??= layout.aside?.bottom ?? null;
    assert.equal(layout.aside?.bottom, besideBottom, `${width}: the sidebar ends where it ended`);
    assert.ok(layout.aside.bottom <= layout.bottomBar.top, `${width}: the sidebar beside the feed above the bottom bar`);
    assert.equal(layout.aside?.width, sidebar, `${width}: the sidebar ${sidebar} px beside the feed`);
    assert.equal(layout.feed.left, sidebar, `${width}: the feed starts at the sidebar`);
    assert.equal(layout.feed.width, width - sidebar, `${width}: the feed takes the rest`);
    assert.equal(layout.segment?.width, sidebar, `${width}: the filter row as wide as the sidebar`);
    assert.equal(layout.topSpaceName, true, `${width}: the space switcher in the top row`);
    assert.equal(layout.overlay, null, `${width}: nothing over the feed`);
    assert.equal(layout.scrollWidth, width, `${width}: nothing wider than the window`);
    console.log(`PASS ${width}: the sidebar ${sidebar} px beside the feed of ${width - sidebar} px`);
  }

  // Over the feed (У1, У4, У12): closed at first, the feed the whole window.
  for (const width of [739, 400, 390]) {
    await resize(width);
    let layout = await read();
    assert.equal(layout.aside, null, `${width}: no sidebar beside the feed`);
    assert.equal(layout.segment, null, `${width}: no filter row in the top row`);
    assert.equal(layout.topSpaceName, false, `${width}: no space switcher in the top row (У12)`);
    assert.equal(layout.sidebarWidthVar, "0px", `${width}: the sidebar takes none of the row`);
    assert.equal(layout.feed.left, 0, `${width}: the feed from the window's left edge`);
    assert.equal(layout.feed.width, width, `${width}: the feed the whole window`);
    assert.equal(layout.overlay, null, `${width}: closed`);
    assert.equal(layout.scrollWidth, width, `${width}: nothing wider than the window`);

    await toggle();
    layout = await read();
    const panelWidth = Math.min(600, width - STRIP);
    assert.equal(layout.panel?.role, "dialog", `${width}: the panel is a dialog`);
    assert.equal(layout.panel.left, 0, `${width}: the panel at the left`);
    assert.equal(layout.panel.width, panelWidth, `${width}: the panel ${panelWidth} px`);
    assert.equal(layout.panel.transform, "none", `${width}: the panel in place`);
    assert.equal(layout.panel.top, layout.header.top, `${width}: the panel from the top row's top`);
    // Down to the window's bottom, over the bottom bar (user's decision of
    // 16.10.2026); what the panel holds ends with it, and its list scrolls
    // inside it.
    assert.equal(layout.panel.bottom, HEIGHT, `${width}: the panel down to the window's bottom`);
    assert.ok(layout.panel.bottom >= layout.bottomBar.bottom, `${width}: the panel over the bottom bar`);
    assert.equal(layout.scrim.bottom, HEIGHT, `${width}: the scrim down to the window's bottom`);
    assert.equal(layout.bottomBarInert, true, `${width}: the bottom bar inert`);
    assert.equal(layout.panelAside?.bottom, HEIGHT, `${width}: the list ends with the panel`);
    assert.equal(layout.panelList.bottom, HEIGHT, `${width}: the list's scroller ends there too`);
    assert.ok(layout.panelList.bottom > besideBottom, `${width}: lower than the sidebar beside the feed`);
    assert.ok(layout.panelList.scrollHeight > layout.panelList.clientHeight, `${width}: the long list overflows its scroller`);
    await page.mouse.move(panelWidth / 2, (layout.panel.top + layout.panel.bottom) / 2);
    await page.mouse.wheel(0, 400);
    await page.waitForFunction(
      () => document.querySelector("[data-sidebar-overlay] [data-sidebar-scroll]").scrollTop > 0,
      null,
      { timeout: 2000 },
    );
    assert.ok((await read()).panel, `${width}: the wheel leaves the panel open`);
    assert.equal(layout.panel.spaceName, true, `${width}: the space switcher in the panel (У12)`);
    assert.equal(layout.panel.list, true, `${width}: the collections in the panel`);
    assert.notEqual(layout.panel.shadow, "none", `${width}: the panel's shadow`);
    assert.equal(layout.scrim.left, 0, `${width}: the scrim over everything`);
    assert.equal(layout.scrim.right, width, `${width}: the scrim to the window's edge, the strip included`);
    // The strip: 40 px, more where the panel stops at its widest (600).
    assert.equal(width - layout.panel.right, width - panelWidth, `${width}: the strip ${width - panelWidth} px`);
    assert.ok(width - layout.panel.right >= STRIP, `${width}: the strip at least 40 px`);
    assert.match(layout.scrim.backdrop, /blur\(/, `${width}: the feed blurred`);
    assert.equal(layout.scrim.opacity, "1", `${width}: the scrim shown`);
    assert.equal(layout.feedInert, true, `${width}: the feed inert`);
    assert.equal(layout.headerInert, true, `${width}: the top row inert`);
    assert.equal(layout.focusInPanel, true, `${width}: the focus in the panel`);
    assert.equal(layout.scrollWidth, width, `${width}: nothing wider than the window`);

    // The strip closes it (У6).
    await page.mouse.click(width - STRIP / 2, layout.panel.top + (layout.panel.bottom - layout.panel.top) / 2);
    layout = await read();
    assert.equal(layout.overlay, null, `${width}: the strip closes`);
    assert.equal(layout.feedInert, false, `${width}: the feed back`);
    console.log(`PASS ${width}: the feed the whole window; the sidebar ${panelWidth} px over it, down to the window's bottom over the bottom bar, its list scrolling; the strip closes`);
  }

  // Escape closes; a collection goes and closes (У6).
  await resize(400);
  await toggle();
  await page.keyboard.press("Escape");
  assert.equal((await read()).overlay, null, "Escape closes");
  await toggle();
  await page.locator("[data-sidebar-overlay-panel] a", { hasText: "Posters" }).click();
  let layout = await read();
  assert.equal(layout.place, "/channel/Posters", "the collection opens");
  assert.equal(layout.overlay, null, "the collection closes the sidebar");
  console.log("PASS 400: Escape and a collection close the sidebar over the feed");

  // The motion: 200 ms in and out on the project's curve.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await toggle();
  const motion = await page.evaluate(() => {
    const panel = getComputedStyle(document.querySelector("[data-sidebar-overlay-panel]"));
    const scrim = getComputedStyle(document.querySelector("[data-sidebar-overlay-scrim]"));
    return { panel: [panel.transitionDuration, panel.transitionTimingFunction], scrim: [scrim.transitionDuration, scrim.transitionTimingFunction] };
  });
  assert.deepEqual(motion.panel, ["0.2s", "cubic-bezier(0.22, 1, 0.36, 1)"], "the panel moves 200 ms");
  assert.deepEqual(motion.scrim, ["0.2s", "cubic-bezier(0.22, 1, 0.36, 1)"], "the scrim fades 200 ms");
  await page.waitForFunction(() => document.querySelector("[data-sidebar-overlay]")?.getAttribute("data-state") === "open");
  await toggle();
  assert.equal((await page.evaluate(readLayout)).overlayState, "closed", "closing, still on screen");
  await page.waitForFunction(() => document.querySelector("[data-sidebar-overlay]") === null, null, { timeout: 2000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  console.log("PASS 400: in and out over 200 ms");

  // Widened with the sidebar open over the feed, it stands beside the feed
  // (У7); narrowed again, it comes over the feed closed.
  await toggle();
  await resize(800);
  layout = await read();
  assert.equal(layout.overlay, null, "800: nothing over the feed");
  assert.equal(layout.aside?.width, TARGET, "800: the sidebar beside the feed at its target");
  await resize(739);
  assert.equal((await read()).overlay, null, "739: closed after narrowing");
  console.log("PASS 739 → 800 → 739: open over the feed becomes beside it, then over it closed");

  // A sidebar collapsed beside the feed stays collapsed across the narrow
  // window (У7).
  await resize(1200);
  await toggle();
  // Collapsed, only the sidebar's 1 px line stays.
  assert.equal((await read()).aside?.width, 1, "1200: collapsed");
  await resize(400);
  assert.equal((await read()).overlay, null, "400: closed over the feed");
  await resize(1200);
  assert.equal((await read()).aside?.width, 1, "1200: still collapsed");
  console.log("PASS 1200 → 400 → 1200: a collapsed sidebar stays collapsed");

  // The page holds the window's minimum, a phone's width (16.10.2026).
  await resize(300);
  await settle();
  assert.equal(await page.evaluate(() => document.querySelector("[data-chrome-shell]").getBoundingClientRect().width), 390, "300: the page holds 390 px");
  console.log("PASS 300: the page no narrower than 390 px");

  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await vite.close();
}
