// The top row over the feed in one row or two in headless Chromium
// (SPEC_NARROW_WINDOW.md, У10): the production row (collection switcher, the
// half over the feed, the selection's commands, useTopRowWrap) under a
// sidebar squeezed by its CSS width (У1). Only the selection's commands take
// a second row: a window too narrow for them sends them right under the row
// and the feed moves down by it; a wide one brings them back. The feed's
// view, the graph's and an open card with a long name keep one row at any
// width. In a narrow window (У15) an open card's name with its menu and close
// button takes the whole row, the place's switcher out of it; with no card,
// or wide, the switcher stands. Starts and stops its own Vite.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { COLD_START_MS, startAuditVite } from "./audit-vite.mjs";

const entry = "/top-row-wrap-audit-entry.js";
const route = "/__top-row-wrap-audit";

const vite = await startAuditVite([{
  name: "top-row-wrap-audit",
  resolveId(id) { if (id === entry) return `\0${entry}`; },
  load(id) {
    if (id !== `\0${entry}`) return;
    return `import React from "react";
      import {createRoot} from "react-dom/client";
      import {ChromeRow, ChromeShell} from "/src/components/ChromeRow.tsx";
      import {GroupSelectionCommands} from "/src/components/GroupSelectionCommands.tsx";
      import {MainSecondaryTopBar} from "/src/components/MainSecondaryChrome.tsx";
      import {TopCollectionSwitcher} from "/src/components/TopCollectionSwitcher.tsx";
      import {TooltipProvider} from "/src/components/ui/tooltip.tsx";
      import {useSidebarOverlay} from "/src/hooks/useSidebarOverlay.ts";
      import {useTopRowWrap} from "/src/hooks/useTopRowWrap.ts";
      import {sidebarWidthCss} from "/src/lib/sidebarPlacement.ts";
      import {topRowShowsPlace} from "/src/lib/topRowPath.ts";
      import "/src/styles/global.css";
      const h=React.createElement, noop=()=>{};
      function Fixture(){
        const wrap=useTopRowWrap();
        // A window too narrow for the sidebar beside the feed: the sidebar
        // and its segment leave the row, as App.tsx has them (У1, У12).
        const narrow=useSidebarOverlay({tab:false,onWidenWhileOpen:noop,onBesideIntent:noop}).narrow;
        React.useLayoutEffect(()=>{
          document.documentElement.style.setProperty("--sidebar-width", narrow?"0px":sidebarWidthCss(360));
        },[narrow]);
        const [host,setHost]=React.useState(null);
        const [count,setCount]=React.useState(0);
        const [card,setCard]=React.useState(null);
        const [view,setView]=React.useState("grid");
        // Whether the sidebar beside the feed is collapsed: only the path
        // reads it here (topRowPath.ts, 23.10.2026).
        const [collapsed,setCollapsed]=React.useState(false);
        React.useEffect(()=>{ window.auditSelect=setCount; window.auditOpenCard=setCard; window.auditView=setView; window.auditCollapse=setCollapsed; },[]);
        const detailBlock=card?{slug:card,title:card,tags:[]}:null;
        const placeShown=topRowShowsPlace({narrow,sidebarBeside:!narrow&&!collapsed,cardOpen:Boolean(card)});
        const blocks=Array.from({length:count},(_,index)=>({slug:"card-"+index}));
        const commands=h(GroupSelectionCommands,{selectedBlocks:blocks,tags:[],currentTag:"Inbox",
          onLoadBlockTags:async()=>new Map(),onBatchSetTag:async()=>true,onCreateAndAssignBatch:noop,
          onRequestDeleteSelection:noop,onMergeSelectedBlocks:noop,onClearSelection:()=>setCount(0)});
        return h(TooltipProvider,null,h(ChromeShell,{ref:wrap.hostRef,"data-top-row":wrap.fit},
          h(ChromeRow,{as:"header",separator:"bottom",className:"bg-chrome"},
            narrow?null:h("div",{"data-audit-sidebar-segment":"",className:"h-full shrink-0 border-r border-sidebar-border",style:{width:"var(--sidebar-width)"}}),
            h("div",{ref:wrap.rowRef,className:"flex h-full min-w-0 flex-1 items-center"},
              // As App.tsx has it: away, the switcher stays in the page, out
              // of the row's flow, faded out and inert.
              h(TopCollectionSwitcher,{shown:placeShown||!card,overlay:!placeShown,currentTag:"Inbox",orderedTags:[{tag:"Inbox",count:3}],onNavigate:noop,
                onCreateCollection:async()=>undefined,joinsNext:true}),
              h(MainSecondaryTopBar,{viewMode:view,detailBlock,detailEntered:Boolean(card),placeBefore:placeShown,onViewModeChange:noop,vaultPath:"",tags:[],onToggleTag:noop,
                onCreateAndAssign:noop,onRequestRename:noop,onRenameFile:async()=>undefined,onCheckFileName:async()=>null,
                onRequestDelete:noop,onDetailClose:noop,detailMenuOpenRequestSequence:0,selectionActive:count>0,
                selectionHostRef:setHost}))),
          h("div",{className:"relative flex min-h-0 flex-1"},
            narrow?null:h("aside",{"data-audit-sidebar":"",className:"shrink-0 border-r border-sidebar-border bg-sidebar",style:{width:"var(--sidebar-width)"}}),
            h("main",{"data-below-top-row":"",className:"min-h-0 flex-1",style:{minWidth:390}})),
          host?createPortalTo(commands,host):null));
      }
      import {createPortal as createPortalTo} from "react-dom";
      createRoot(document.getElementById("root")).render(h(Fixture));`;
  },
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url !== route) return next();
      res.setHeader("Content-Type", "text/html");
      res.end(await server.transformIndexHtml(req.url, `<html><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`));
    });
  },
}]);

/** Where the path's parts stand in the row (У15). */
function readPath() {
  const box = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  };
  const name = document.querySelector("[data-secondary-detail-card-name]");
  const layer = document.querySelector("[data-secondary-detail-top-menu]");
  const buttons = layer ? [...layer.querySelectorAll("button")].map((button) => button.getBoundingClientRect()) : [];
  return {
    fit: document.querySelector("[data-chrome-shell]").getAttribute("data-top-row"),
    header: box("header"),
    place: box("[data-top-collection-switcher-slot]:not([inert]) [data-top-collection-switcher]"),
    bar: box("[data-top-row-bar]"),
    layer: box("[data-secondary-detail-top-menu]"),
    name: box("[data-secondary-detail-card-name]"),
    nameCut: name ? name.scrollWidth > name.clientWidth : null,
    nameEllipsis: name ? getComputedStyle(name).textOverflow : null,
    buttons: buttons.map((r) => ({ left: r.left, right: r.right })),
    pathLine: document.querySelector("[data-path-card-line]") !== null,
    mainTop: box("main").top,
  };
}

/** Where the row's parts stand, and whether any of them is cut. */
function readRow() {
  const box = (element) => element.getBoundingClientRect();
  const shell = document.querySelector("[data-chrome-shell]");
  const header = box(document.querySelector("header"));
  const bar = document.querySelector("[data-top-row-bar]");
  const barBox = box(bar);
  const cut = [...document.querySelectorAll("[data-top-row-part]")]
    .filter((part) => !part.closest('[data-entered="false"]'))
    .filter((part) => box(part).left < barBox.left - 0.5 || box(part).right > barBox.right + 0.5)
    .map((part) => part.textContent.trim());
  return {
    fit: shell.getAttribute("data-top-row"),
    headerBottom: header.bottom,
    bar: { top: barBox.top, bottom: barBox.bottom, left: barBox.left, right: barBox.right },
    barInHeader: barBox.bottom <= header.bottom + 0.5,
    sidebarRight: box(document.querySelector("[data-audit-sidebar]")).right,
    mainTop: box(document.querySelector("main")).top,
    cut,
  };
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(new URL(route, vite.origin).href);
  await page.locator("[data-top-row-bar]").waitFor({ timeout: COLD_START_MS });
  const settle = () => page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }));
  const read = async () => { await settle(); return page.evaluate(readRow); };

  // Only the selection's commands take a second row (У10): the feed's view,
  // the graph's and an open card with a long name stay in one row at any
  // width, the name ending in an ellipsis.
  const LONG_NAME = "пытаюсь использовать топологический анализ данных для поиска структуры в эмбеддингах";
  // 559 is the narrowest window with the sidebar beside the feed (169 + 390 at the standard chrome,
  // user's decision of 22.10.2026; it was 740).
  for (const width of [1200, 559]) {
    await page.setViewportSize({ width, height: 700 });
    for (const [label, setup] of [
      ["feed", () => { window.auditOpenCard(null); window.auditView("grid"); }],
      ["graph", () => { window.auditOpenCard(null); window.auditView("graph"); }],
      ["open card", (name) => { window.auditView("grid"); window.auditOpenCard(name); }],
    ]) {
      await page.evaluate(setup, LONG_NAME);
      const state = await read();
      assert.equal(state.fit, "one", `${width} ${label}: one row`);
      assert.equal(state.barInHeader, true, `${width} ${label}: the half stays in the row`);
      assert.equal(state.mainTop, state.headerBottom + 1, `${width} ${label}: the feed under the row's line`);
    }
    if (width === 559) {
      const nameCut = await page.evaluate(() => {
        const name = document.querySelector("[data-secondary-detail-card-name]");
        return name.scrollWidth > name.clientWidth;
      });
      assert.equal(nameCut, true, "559 open card: the long name ends in an ellipsis");
    }
    console.log(`PASS ${width}: feed, graph and an open card with a long name keep one row`);
  }
  await page.evaluate(() => window.auditOpenCard(null));

  // A narrow window (У15): with no card the place's switcher starts the row;
  // an open card's name with its menu and close button takes the whole row,
  // no switcher and no path's line before it, the name ending in an
  // ellipsis.
  const readPathSettled = async () => { await settle(); return page.evaluate(readPath); };
  for (const width of [558, 480, 390]) {
    await page.setViewportSize({ width, height: 700 });
    await page.evaluate(() => window.auditOpenCard(null));
    let path = await readPathSettled();
    assert.notEqual(path.place, null, `${width} no card: the place's switcher stands`);
    assert.equal(path.place.left, 0, `${width} no card: the switcher starts the row`);

    await page.evaluate((name) => window.auditOpenCard(name), LONG_NAME);
    path = await readPathSettled();
    assert.equal(path.place, null, `${width} open card: no place's switcher`);
    assert.equal(path.pathLine, false, `${width} open card: no path's line`);
    assert.equal(path.fit, "one", `${width} open card: one row`);
    assert.equal(path.mainTop, path.header.bottom + 1, `${width} open card: the feed under the row's line`);
    assert.equal(path.bar.left, 0, `${width} open card: the half starts at the window's edge`);
    assert.equal(path.bar.right, width, `${width} open card: the half runs to the window's edge`);
    assert.equal(path.layer.left, 0, `${width} open card: the name's layer starts at the window's edge`);
    assert.equal(path.layer.right, width, `${width} open card: the name's layer runs to the window's edge`);
    assert.equal(path.name.left, 8, `${width} open card: the name's pill on the 8 px padding from the edge`);
    assert.equal(path.buttons.length, 2, `${width} open card: ⋯ and ×`);
    const [more, close] = path.buttons;
    assert.ok(path.name.right <= more.left + 0.5, `${width} open card: the name ends before ⋯`);
    assert.ok(more.right <= close.left + 0.5, `${width} open card: ⋯ before ×`);
    assert.ok(close.right <= width && close.right >= width - 16, `${width} open card: × at the row's right end`);
    assert.equal(path.nameEllipsis, "ellipsis", `${width} open card: a name that does not fit ends in an ellipsis`);
    // The long name does not fit the whole row at any narrow width.
    if (width <= 600) assert.equal(path.nameCut, true, `${width} open card: the long name does not fit`);
    console.log(`PASS ${width}: no card, the place starts the row; an open card's name, ⋯ and × take the whole row`);
  }
  // Wide with the sidebar open beside the feed, the sidebar shows the place:
  // the open card's name stands alone after the sidebar's segment (user's
  // decision of 23.10.2026). With the sidebar collapsed the switcher stands
  // before the name, past the path's line.
  await page.setViewportSize({ width: 1200, height: 700 });
  let widePath = await readPathSettled();
  assert.equal(widePath.place, null, "1200 open card beside the open sidebar: no place's switcher");
  assert.equal(widePath.pathLine, false, "1200 open card beside the open sidebar: no path's line");
  await page.evaluate(() => window.auditCollapse(true));
  widePath = await readPathSettled();
  assert.notEqual(widePath.place, null, "1200 open card, sidebar collapsed: the place's switcher stands");
  assert.equal(widePath.pathLine, true, "1200 open card, sidebar collapsed: the path's line before the name");
  assert.ok(widePath.layer.left > widePath.place.right, "1200 open card, sidebar collapsed: the name past the place");
  await page.evaluate(() => { window.auditCollapse(false); window.auditOpenCard(null); });
  console.log("PASS 1200: an open card's name alone beside the open sidebar, past the place's switcher with it collapsed");

  // Wide, with a selection: one row while the commands fit, the feed right
  // under it. A count that ends in an ellipsis alone keeps one row.
  await page.evaluate(() => window.auditSelect(12));
  let row;
  for (const width of [1200, 800]) {
    await page.setViewportSize({ width, height: 700 });
    row = await read();
    assert.equal(row.fit, "one", `${width}: one row`);
    assert.equal(row.barInHeader, true, `${width}: the commands stay in the row`);
    assert.deepEqual(row.cut, [], `${width}: the commands whole`);
    assert.equal(row.mainTop, row.headerBottom + 1, `${width}: the feed under the row's line`);
    console.log(`PASS ${width}: one row, the commands whole`);
  }

  // Narrower: the commands no longer fit and take a second row. At 760 the
  // second row holds them whole; below about 350 px of feed even it is too
  // narrow and they scroll, as they did in one row.
  for (const width of [760, 750, 745, 740]) {
    await page.setViewportSize({ width, height: 700 });
    row = await read();
    assert.equal(row.fit, "two", `${width}: two rows`);
    assert.equal(row.bar.top, row.headerBottom + 1, `${width}: the second row right under the row's line`);
    assert.equal(row.bar.left, row.sidebarRight, `${width}: the second row starts at the feed`);
    assert.equal(row.bar.right, width, `${width}: the second row runs to the window's edge`);
    assert.equal(row.mainTop, row.bar.bottom, `${width}: the feed moves down by the second row`);
    // The sidebar squeezes before the feed gives way past its narrowest (У1).
    assert.equal(width - row.sidebarRight, Math.max(390, width - 360), `${width}: the feed keeps its narrowest`);
    if (width === 760) assert.deepEqual(row.cut, [], `${width}: the commands whole`);
    console.log(`PASS ${width}: two rows, the feed below them${row.cut.length ? "; the commands scroll in the second row" : ", the commands whole"}`);
  }

  // The tall chrome (SPEC_TABS.md, В83): the second row steps as the row,
  // a sidebar table row with its line.
  await page.setViewportSize({ width: 760, height: 700 });
  await page.evaluate(() => { document.documentElement.dataset.chromeHeight = "40"; });
  row = await read();
  assert.equal(row.fit, "two", "760 tall: two rows");
  assert.equal(row.bar.bottom - row.bar.top, 40, "760 tall: the second row and its line make 40");
  assert.equal(row.mainTop, row.bar.bottom, "760 tall: the feed moves down by the second row");
  await page.evaluate(() => { delete document.documentElement.dataset.chromeHeight; });
  await page.setViewportSize({ width: 740, height: 700 });
  console.log("PASS 760 tall: the second row steps 40");

  // The selection ends: the view's controls fit in one row again.
  await page.evaluate(() => window.auditSelect(0));
  row = await read();
  assert.equal(row.fit, "one", "740 without a selection: one row");
  assert.equal(row.mainTop, row.headerBottom + 1, "740 without a selection: the feed back under the row");
  assert.deepEqual(row.cut, [], "740 without a selection: nothing cut");
  console.log("PASS 740 without a selection: back to one row");

  // Wide again with the selection: back to one row.
  await page.evaluate(() => window.auditSelect(12));
  await page.setViewportSize({ width: 1200, height: 700 });
  row = await read();
  assert.equal(row.fit, "one", "1200 again: one row");
  assert.equal(row.mainTop, row.headerBottom + 1, "1200 again: the feed back under the row");
  console.log("PASS 1200 again: one row");

  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await vite.close();
}
