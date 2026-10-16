// The top row over the feed in one row or two in headless Chromium
// (SPEC_NARROW_WINDOW.md, У10): the production row (collection switcher, the
// half over the feed, the selection's commands, useTopRowWrap) under a
// sidebar squeezed by its CSS width (У1). Only the selection's commands take
// a second row: a window too narrow for them sends them right under the row
// and the feed moves down by it; a wide one brings them back. The feed's
// view, the graph's and an open card with a long name keep one row at any
// width. Starts and stops its own Vite.
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
      import {useTopRowWrap} from "/src/hooks/useTopRowWrap.ts";
      import {sidebarWidthCss} from "/src/lib/sidebarPlacement.ts";
      import "/src/styles/global.css";
      const h=React.createElement, noop=()=>{};
      document.documentElement.style.setProperty("--sidebar-width", sidebarWidthCss(360));
      function Fixture(){
        const wrap=useTopRowWrap();
        const [host,setHost]=React.useState(null);
        const [count,setCount]=React.useState(0);
        const [card,setCard]=React.useState(null);
        const [view,setView]=React.useState("grid");
        React.useEffect(()=>{ window.auditSelect=setCount; window.auditOpenCard=setCard; window.auditView=setView; },[]);
        const detailBlock=card?{slug:card,title:card,tags:[]}:null;
        const blocks=Array.from({length:count},(_,index)=>({slug:"card-"+index}));
        const commands=h(GroupSelectionCommands,{selectedBlocks:blocks,tags:[],currentTag:"Inbox",
          onLoadBlockTags:async()=>new Map(),onBatchSetTag:async()=>true,onCreateAndAssignBatch:noop,
          onRequestDeleteSelection:noop,onMergeSelectedBlocks:noop,onClearSelection:()=>setCount(0)});
        return h(TooltipProvider,null,h(ChromeShell,{ref:wrap.hostRef,"data-top-row":wrap.fit},
          h(ChromeRow,{as:"header",separator:"bottom",className:"bg-chrome"},
            h("div",{"data-audit-sidebar-segment":"",className:"h-full shrink-0 border-r border-sidebar-border",style:{width:"var(--sidebar-width)"}}),
            h("div",{ref:wrap.rowRef,className:"flex h-full min-w-0 flex-1 items-center"},
              h(TopCollectionSwitcher,{currentTag:"Inbox",orderedTags:[{tag:"Inbox",count:3}],onNavigate:noop,
                onCreateCollection:async()=>undefined,joinsNext:true}),
              h(MainSecondaryTopBar,{viewMode:view,detailBlock,detailEntered:Boolean(card),onViewModeChange:noop,vaultPath:"",tags:[],onToggleTag:noop,
                onCreateAndAssign:noop,onRequestRename:noop,onRenameFile:async()=>undefined,onCheckFileName:async()=>null,
                onRequestDelete:noop,onDetailClose:noop,detailMenuOpenRequestSequence:0,selectionActive:count>0,
                selectionHostRef:setHost}))),
          h("div",{className:"relative flex min-h-0 flex-1"},
            h("aside",{"data-audit-sidebar":"",className:"shrink-0 border-r border-sidebar-border bg-sidebar",style:{width:"var(--sidebar-width)"}}),
            h("main",{"data-below-top-row":"",className:"min-h-0 flex-1",style:{minWidth:304}})),
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
  for (const width of [1200, 618]) {
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
    if (width === 618) {
      const nameCut = await page.evaluate(() => {
        const name = document.querySelector("[data-secondary-detail-card-name]");
        return name.scrollWidth > name.clientWidth;
      });
      assert.equal(nameCut, true, "618 open card: the long name ends in an ellipsis");
    }
    console.log(`PASS ${width}: feed, graph and an open card with a long name keep one row`);
  }
  await page.evaluate(() => window.auditOpenCard(null));
  await page.setViewportSize({ width: 1200, height: 700 });

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
  for (const width of [760, 664, 640, 618]) {
    await page.setViewportSize({ width, height: 700 });
    row = await read();
    assert.equal(row.fit, "two", `${width}: two rows`);
    assert.equal(row.bar.top, row.headerBottom + 1, `${width}: the second row right under the row's line`);
    assert.equal(row.bar.left, row.sidebarRight, `${width}: the second row starts at the feed`);
    assert.equal(row.bar.right, width, `${width}: the second row runs to the window's edge`);
    assert.equal(row.mainTop, row.bar.bottom, `${width}: the feed moves down by the second row`);
    // The sidebar squeezes before the feed gives way past its narrowest (У1).
    assert.equal(width - row.sidebarRight, Math.max(304, width - 360), `${width}: the feed keeps its narrowest`);
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
  await page.setViewportSize({ width: 618, height: 700 });
  console.log("PASS 760 tall: the second row steps 40");

  // The selection ends: the view's controls fit in one row again.
  await page.evaluate(() => window.auditSelect(0));
  row = await read();
  assert.equal(row.fit, "one", "618 without a selection: one row");
  assert.equal(row.mainTop, row.headerBottom + 1, "618 without a selection: the feed back under the row");
  assert.deepEqual(row.cut, [], "618 without a selection: nothing cut");
  console.log("PASS 618 without a selection: back to one row");

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
