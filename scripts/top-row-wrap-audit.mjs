// The top row over the feed in one row or two in headless Chromium
// (SPEC_NARROW_WINDOW.md, У10): the production row (collection switcher, the
// half over the feed, the selection's commands, useTopRowWrap) under a
// sidebar squeezed by its CSS width (У1). Only the selection's commands take
// a second row: a window too narrow for them sends them right under the row
// and the feed moves down by it; a wide one brings them back. The feed's
// view, the graph's and an open card with a long name keep one row at any
// width. The row names one place (DESIGN_SYSTEM.md, «Одно название в ряду»;
// user's decision of 11.11.2026): an open card's name with its menu and close
// button takes the place's room full page, in a narrow window and wide, the
// sidebar open or collapsed; with no card the place's name stands, first in
// the row while the sidebar is hidden, which then has no segment; under the
// card's window the row names the place beside the open sidebar and nothing
// with it hidden. The place's name takes the row up to the feed's controls
// and ends in an ellipsis only where it meets them, 4 px before them as the
// open card's name before ⋯; with a selection in the row it keeps to half
// the row, with the selection in a second row it has the first row again;
// out of the row's flow it keeps the width it had (user's decision of
// 15.11.2026). A name's rename field is as wide as its text up to what caps
// the name at rest (01.11.2026), the sidebar open or collapsed. Starts and
// stops its own Vite.
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
      import {sidebarWidthHost, writeSidebarWidth} from "/src/lib/sidebarWidth.ts";
      import {topRowCard, topRowShowsPlace} from "/src/lib/topRowPath.ts";
      import "/src/styles/global.css";
      const h=React.createElement, noop=()=>{};
      function Fixture(){
        const wrap=useTopRowWrap();
        // A window too narrow for the sidebar beside the feed: the sidebar
        // and its segment leave the row, as App.tsx has them (У1, У12).
        const narrow=useSidebarOverlay({tab:false,onWidenWhileOpen:noop,onBesideIntent:noop}).narrow;
        // Whether the sidebar beside the feed is collapsed: its width is none
        // and its segment holds nothing (topRowPath.ts, 11.11.2026).
        const [collapsed,setCollapsed]=React.useState(false);
        React.useLayoutEffect(()=>{
          writeSidebarWidth(narrow||collapsed?"0px":sidebarWidthCss(360));
        },[narrow,collapsed]);
        const [host,setHost]=React.useState(null);
        const [count,setCount]=React.useState(0);
        const [card,setCard]=React.useState(null);
        // How an open card stands: full page or in its window (SPEC_CARD_PEEK.md, О5).
        const [cardView,setCardView]=React.useState("full");
        const [view,setView]=React.useState("grid");
        // The collection the feed shows: its name is the place's name.
        const [tag,setTag]=React.useState("Inbox");
        React.useEffect(()=>{ window.auditSelect=setCount; window.auditOpenCard=setCard; window.auditView=setView; window.auditCollapse=setCollapsed; window.auditCardView=setCardView; window.auditTag=setTag; },[]);
        const beside=!narrow&&!collapsed;
        const detailBlock=topRowCard(card?{slug:card,title:card,tags:[]}:null,cardView);
        const placeShown=topRowShowsPlace({sidebar:beside?"beside":"hidden",card:!card?"none":cardView==="peek"?"window":"full"});
        const blocks=Array.from({length:count},(_,index)=>({slug:"card-"+index}));
        const commands=h(GroupSelectionCommands,{selectedBlocks:blocks,tags:[],currentTag:"Inbox",
          onLoadBlockTags:async()=>new Map(),onBatchSetTag:async()=>true,onCreateAndAssignBatch:noop,
          onRequestDeleteSelection:noop,onMergeSelectedBlocks:noop,onClearSelection:()=>setCount(0)});
        return h(TooltipProvider,null,h(ChromeShell,{ref:wrap.hostRef,"data-top-row":wrap.fit},
          h(ChromeRow,{as:"header",separator:"bottom",className:"bg-chrome"},
            narrow?null:h("div",{ref:sidebarWidthHost,"data-audit-sidebar-segment":"",className:"h-full shrink-0 overflow-hidden"+(beside?" border-r border-sidebar-border":""),style:{width:"var(--sidebar-width)"}}),
            h("div",{ref:wrap.rowRef,className:"flex h-full min-w-0 flex-1 items-center"},
              // As App.tsx has it: away, the switcher stays in the page, out
              // of the row's flow, faded out and inert.
              h(TopCollectionSwitcher,{shown:placeShown,overlay:!placeShown,currentTag:tag,onRename:async()=>undefined,
                selectionActive:count>0,joinsNext:true}),
              h(MainSecondaryTopBar,{viewMode:view,detailBlock,detailEntered:Boolean(detailBlock),onViewModeChange:noop,vaultPath:"",tags:[],onToggleTag:noop,
                onCreateAndAssign:noop,onRequestRename:noop,onRenameFile:async()=>undefined,onCheckFileName:async()=>null,
                onRequestDelete:noop,onDetailClose:noop,detailMenuOpenRequestSequence:0,selectionActive:count>0,
                selectionHostRef:setHost}))),
          h("div",{className:"relative flex min-h-0 flex-1"},
            narrow?null:h("aside",{ref:sidebarWidthHost,"data-audit-sidebar":"",className:"shrink-0 border-r border-sidebar-border bg-sidebar",style:{width:"var(--sidebar-width)"}}),
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
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
  };
  const name = document.querySelector("[data-secondary-detail-card-name]");
  const layer = document.querySelector("[data-secondary-detail-top-menu]");
  const buttons = layer ? [...layer.querySelectorAll("button")].map((button) => button.getBoundingClientRect()) : [];
  const segment = document.querySelector("[data-audit-sidebar-segment]");
  return {
    fit: document.querySelector("[data-chrome-shell]").getAttribute("data-top-row"),
    header: box("header"),
    segment: segment ? { ...box("[data-audit-sidebar-segment]"), line: getComputedStyle(segment).borderRightWidth } : null,
    place: box("[data-top-collection-switcher-slot]:not([inert]) [data-top-collection-switcher]"),
    placeName: box("[data-top-collection-switcher-slot]:not([inert]) [data-top-collection-name]"),
    viewSwitch: box("[data-main-view-mode-switcher]"),
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

/** Where the place's name, its slot and the feed's controls stand. */
function readPlace() {
  const box = (selector) => {
    const element = document.querySelector(selector);
    return element ? element.getBoundingClientRect().toJSON() : null;
  };
  const slot = document.querySelector("[data-top-collection-switcher-slot]");
  const name = slot.querySelector("[data-top-collection-name]");
  return {
    fit: document.querySelector("[data-chrome-shell]").getAttribute("data-top-row"),
    row: slot.parentElement.getBoundingClientRect().toJSON(),
    slot: slot.getBoundingClientRect().toJSON(),
    inert: slot.hasAttribute("inert"),
    name: name.getBoundingClientRect().toJSON(),
    nameCut: name.scrollWidth > name.clientWidth,
    nameEllipsis: getComputedStyle(name).textOverflow,
    controls: box("[data-main-view-mode-switcher]"),
  };
}

/**
 * A name's rename field in the path (`ChromeNameField`): its box, its
 * padding, how far its text runs and where the text ends while the cursor
 * stands after the last glyph. `limit` is the selector of what caps it.
 */
function readNameField({ marker, limit }) {
  const input = document.querySelector(`[data-${marker}-input]`);
  if (!input) return null;
  const style = getComputedStyle(input);
  const context = document.createElement("canvas").getContext("2d");
  // The shorthand reads empty when a longhand has no shorthand form.
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  context.letterSpacing = style.letterSpacing;
  const textWidth = context.measureText(input.value).width;
  const box = input.getBoundingClientRect();
  const paddingLeft = parseFloat(style.paddingLeft);
  return {
    left: box.left,
    right: box.right,
    width: box.width,
    paddingLeft,
    paddingRight: parseFloat(style.paddingRight),
    fieldSizing: style.fieldSizing,
    textWidth,
    scrolls: input.scrollWidth > input.clientWidth,
    // The cursor stands at the end: the input is scrolled as far as it goes.
    textRight: box.left + paddingLeft + textWidth - input.scrollLeft,
    limit: document.querySelector(limit).getBoundingClientRect().toJSON(),
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
  const SHORT_CARD = "Nogal";
  // 670 is the narrowest window with the sidebar beside the feed (280 + 390,
  // user's decisions of 22.10.2026 and 25.10.2026; it was 740, then 559,
  // then 630).
  for (const width of [1200, 670]) {
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
    if (width === 670) {
      const nameCut = await page.evaluate(() => {
        const name = document.querySelector("[data-secondary-detail-card-name]");
        return name.scrollWidth > name.clientWidth;
      });
      assert.equal(nameCut, true, "670 open card: the long name ends in an ellipsis");
    }
    console.log(`PASS ${width}: feed, graph and an open card with a long name keep one row`);
  }
  await page.evaluate(() => window.auditOpenCard(null));

  // A narrow window (У15): with no card the place's switcher starts the row;
  // an open card's name with its menu and close button takes the whole row,
  // no switcher and no path's line before it, the name ending in an
  // ellipsis.
  const readPathSettled = async () => { await settle(); return page.evaluate(readPath); };
  for (const width of [669, 480, 390]) {
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
    if (width <= 669) assert.equal(path.nameCut, true, `${width} open card: the long name does not fit`);
    console.log(`PASS ${width}: no card, the place starts the row; an open card's name, ⋯ and × take the whole row`);
  }
  // Wide with the sidebar open beside the feed, the sidebar shows the place:
  // the open card's name stands alone after the sidebar's segment (user's
  // decision of 23.10.2026). Collapsed, the row names one place: no segment,
  // the place's name first with no card, the card's name alone with one
  // (user's decision of 11.11.2026).
  await page.setViewportSize({ width: 1200, height: 700 });
  let widePath = await readPathSettled();
  assert.equal(widePath.place, null, "1200 open card beside the open sidebar: no place's switcher");
  assert.equal(widePath.pathLine, false, "1200 open card beside the open sidebar: no path's line");
  assert.equal(widePath.layer.left, widePath.segment.right, "1200 open card beside the open sidebar: the name right after the segment's line");
  await page.evaluate(() => window.auditCollapse(true));
  widePath = await readPathSettled();
  assert.equal(widePath.segment.width, 0, "1200 sidebar collapsed: the segment takes none of the row");
  assert.equal(widePath.segment.line, "0px", "1200 sidebar collapsed: no segment's line");
  assert.equal(widePath.place, null, "1200 open card, sidebar collapsed: no place's name");
  assert.equal(widePath.pathLine, false, "1200 open card, sidebar collapsed: no path's line");
  assert.equal(widePath.bar.left, 0, "1200 open card, sidebar collapsed: the half starts at the window's edge");
  assert.equal(widePath.layer.left, 0, "1200 open card, sidebar collapsed: the name's layer from the window's edge");
  assert.equal(widePath.name.left, 8, "1200 open card, sidebar collapsed: the name's pill on the 8 px padding");
  assert.equal(widePath.buttons.length, 2, "1200 open card, sidebar collapsed: ⋯ and ×");
  assert.ok(widePath.buttons[1].right >= 1200 - 16, "1200 open card, sidebar collapsed: × at the row's right end");
  await page.evaluate(() => window.auditOpenCard(null));
  widePath = await readPathSettled();
  assert.notEqual(widePath.place, null, "1200 no card, sidebar collapsed: the place's name stands");
  assert.equal(widePath.place.left, 0, "1200 no card, sidebar collapsed: the place's name starts the row");
  assert.equal(widePath.placeName.left, 8, "1200 no card, sidebar collapsed: its name on the 8 px padding");
  // The card's window: nothing names the place with the sidebar hidden, the
  // feed's controls stay where they stand (SPEC_CARD_PEEK.md, О5).
  const controlsAlone = widePath.viewSwitch;
  await page.evaluate((name) => { window.auditCardView("peek"); window.auditOpenCard(name); }, SHORT_CARD);
  widePath = await readPathSettled();
  assert.equal(widePath.place, null, "1200 card's window, sidebar collapsed: no place's name");
  assert.equal(widePath.layer, null, "1200 card's window, sidebar collapsed: no card's name in the row");
  assert.deepEqual(widePath.viewSwitch, controlsAlone, "1200 card's window, sidebar collapsed: Grid / Graph and Display where they stood");
  await page.evaluate(() => window.auditCollapse(false));
  widePath = await readPathSettled();
  assert.notEqual(widePath.place, null, "1200 card's window beside the open sidebar: the place's name stands");
  assert.equal(widePath.place.left, widePath.segment.right, "1200 card's window beside the open sidebar: the place after the segment's line");
  assert.equal(widePath.layer, null, "1200 card's window beside the open sidebar: no card's name in the row");
  await page.evaluate(() => { window.auditOpenCard(null); window.auditCardView("full"); });
  console.log("PASS 1200: an open card's name alone beside the open sidebar and with it collapsed, the place first with no card, nothing named under the card's window with the sidebar hidden");

  // The place's name takes the row up to the feed's controls (user's
  // decision of 15.11.2026): a long one ends in an ellipsis 4 px before
  // Grid / Graph, the gap the open card's name keeps before ⋯, at every
  // width, the sidebar open, collapsed or over the feed; the controls keep
  // their width and their place at the window's edge. A short one stands
  // whole with the rest of the row empty after it.
  const LONG_PLACE = "Города, здания и обитаемые пространства: архитектура, урбанизм и интерьеры ".repeat(3).trim();
  const readPlaceSettled = async () => { await settle(); return page.evaluate(readPlace); };
  await page.evaluate(() => { window.auditOpenCard(null); window.auditSelect(0); window.auditView("grid"); });
  let controlsAtRest = null;
  for (const collapsed of [false, true]) {
    await page.evaluate((value) => window.auditCollapse(value), collapsed);
    for (const width of [1200, 900, 670, 669, 480, 390]) {
      await page.setViewportSize({ width, height: 700 });
      const label = `${width} sidebar ${width <= 669 ? "over the feed" : collapsed ? "collapsed" : "open"}`;
      await page.evaluate((tag) => window.auditTag(tag), LONG_PLACE);
      let place = await readPlaceSettled();
      controlsAtRest ??= place.controls;
      assert.equal(place.fit, "one", `${label}: one row`);
      assert.equal(place.nameCut, true, `${label}: the long name does not fit`);
      assert.equal(place.nameEllipsis, "ellipsis", `${label}: the long name ends in an ellipsis`);
      assert.ok(Math.abs(place.controls.left - place.name.right - 4) <= 0.5,
        `${label}: the long name ends 4 px before Grid / Graph (${place.name.right} for ${place.controls.left})`);
      assert.ok(Math.abs(place.controls.width - controlsAtRest.width) <= 0.5, `${label}: Grid / Graph and Display keep their width`);
      assert.ok(Math.abs((width - place.controls.right) - (1200 - controlsAtRest.right)) <= 0.5,
        `${label}: Grid / Graph and Display keep their place at the window's edge`);
      await page.evaluate(() => window.auditTag("Inbox"));
      place = await readPlaceSettled();
      assert.equal(place.nameCut, false, `${label}: a short name stands whole`);
      assert.ok(place.slot.right < place.controls.left - 4, `${label}: a short name leaves the row empty after it`);
      console.log(`PASS ${label}: the long place's name ends 4 px before Grid / Graph, ${Math.round(place.controls.width)} px of controls kept`);
    }
  }

  // With a selection in the row its commands take half the row and the name
  // keeps to the other; with the commands in a second row the first row is
  // the name's again; without them the name meets Grid / Graph once more.
  await page.evaluate((tag) => { window.auditCollapse(false); window.auditTag(tag); window.auditSelect(12); }, LONG_PLACE);
  await page.setViewportSize({ width: 1200, height: 700 });
  let place = await readPlaceSettled();
  assert.equal(place.fit, "one", "1200 with a selection: one row");
  assert.ok(Math.abs(place.slot.width - place.row.width / 2) <= 0.5, "1200 with a selection: the long name keeps to half the row");
  await page.setViewportSize({ width: 740, height: 700 });
  place = await readPlaceSettled();
  assert.equal(place.fit, "two", "740 with a selection: two rows");
  assert.ok(Math.abs(place.slot.right - place.row.right) <= 0.5, "740 with the commands in the second row: the name takes the first row");
  assert.equal(place.nameCut, true, "740 with the commands in the second row: the long name still ends in an ellipsis");
  await page.evaluate(() => window.auditSelect(0));
  place = await readPlaceSettled();
  assert.equal(place.fit, "one", "740 without a selection: one row");
  assert.ok(Math.abs(place.controls.left - place.name.right - 4) <= 0.5, "740 without a selection: the name ends 4 px before Grid / Graph");
  console.log("PASS selection: half the row in one row, the first row in two, up to Grid / Graph without it");

  // Out of the row's flow, faded out and inert, the name keeps the width it
  // had: under the card's window and with a card full page it never lies over
  // the feed's controls or the card's.
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.evaluate(() => window.auditCollapse(true));
  const inFlow = await readPlaceSettled();
  for (const cardView of ["peek", "full"]) {
    await page.evaluate((view) => { window.auditCardView(view); window.auditOpenCard("Nogal"); }, cardView);
    place = await readPlaceSettled();
    assert.equal(place.inert, true, `${cardView}: the place's name leaves the row`);
    assert.ok(Math.abs(place.slot.left - inFlow.slot.left) <= 0.5 && Math.abs(place.slot.width - inFlow.slot.width) <= 0.5,
      `${cardView}: the name keeps the box it had in the row (${place.slot.width} for ${inFlow.slot.width})`);
    if (cardView === "peek") assert.ok(place.slot.right <= place.controls.left - 4 + 0.5, "peek: the name stays off Grid / Graph");
    else {
      const more = await page.locator("[data-secondary-detail-top-menu] [data-chrome-actions]").boundingBox();
      assert.ok(place.slot.right <= more.x + 0.5, "full: the name stays off the card's ⋯ and ×");
    }
    await page.evaluate(() => window.auditOpenCard(null));
    await readPlaceSettled();
  }
  await page.evaluate(() => { window.auditCardView("full"); window.auditCollapse(false); window.auditTag("Inbox"); });
  console.log("PASS out of the row's flow: the place's name keeps its box, off the feed's and the card's controls");

  // A name's rename field is as wide as its text with the name's 8 px on both
  // sides, as at rest (field-sizing, user's decision of 01.11.2026), and what
  // caps the name at rest caps the field: the room up to Grid / Graph for the
  // collection (15.11.2026), the room up to ⋯ for the open card. At the cap the text
  // scrolls inside and the 8 px after its last glyph stay.
  const SHORT_NAME = "Nogal";
  const TYPED = " House on the hill";
  // Longer than the row at 1200 px.
  const OVERFLOW = " and the long road down to the river that runs past the old mill at dawn".repeat(3);
  for (const { label, marker, limit, open, collapsed } of [false, true].flatMap((collapsed) => [
    { label: "collection", marker: "top-collection-name", limit: "[data-top-collection-switcher-slot]", open: () => window.auditOpenCard(null) },
    { label: "open card", marker: "secondary-detail-card-name", limit: "[data-secondary-detail-top-menu] [data-chrome-actions]",
      open: (name) => window.auditOpenCard(name) },
  ].map((entry) => ({ ...entry, collapsed, label: `${entry.label}, sidebar ${collapsed ? "collapsed" : "open"}` })))) {
    await page.evaluate((value) => window.auditCollapse(value), collapsed);
    await page.evaluate(open, SHORT_NAME);
    await settle();
    const rest = await page.locator(`[data-${marker}]`).boundingBox();
    const slotAtRest = await page.locator("[data-top-collection-switcher-slot]").boundingBox();
    await page.locator(`[data-${marker}]`).click();
    await page.locator(`[data-${marker}-input]`).waitFor();
    const readField = async () => { await settle(); return page.evaluate(readNameField, { marker, limit }); };
    const fits = (field, what) => {
      assert.equal(field.fieldSizing, "content", `${label} ${what}: the field follows its text`);
      assert.equal(field.paddingLeft, 8, `${label} ${what}: 8 px before the text`);
      assert.equal(field.paddingRight, 8, `${label} ${what}: 8 px after the text`);
      assert.ok(Math.abs(field.width - (field.textWidth + 16)) <= 2,
        `${label} ${what}: as wide as its text and the 8 px on both sides (${field.width} for ${field.textWidth})`);
      assert.equal(field.scrolls, false, `${label} ${what}: the whole text shows`);
    };
    let field = await readField();
    fits(field, "opened");
    assert.ok(Math.abs(field.width - rest.width) <= 2, `${label}: the field as wide as the name at rest`);
    assert.ok(Math.abs(field.left - rest.x) <= 0.5, `${label}: the field where the name stood`);
    if (marker === "top-collection-name") {
      const slot = await page.locator("[data-top-collection-switcher-slot]").boundingBox();
      assert.ok(Math.abs(slot.width - slotAtRest.width) <= 2, "collection: the place keeps its width when the field opens");
    }
    const opened = field.width;

    await page.keyboard.type(TYPED);
    field = await readField();
    fits(field, "typed");
    assert.ok(field.width > opened + 50, `${label}: the field grows with the typed text`);

    await page.keyboard.type(OVERFLOW);
    field = await readField();
    assert.equal(field.scrolls, true, `${label} at the cap: the text scrolls inside`);
    if (marker === "top-collection-name") {
      const controls = await page.locator("[data-main-view-mode-switcher]").boundingBox();
      assert.ok(Math.abs(field.right - (controls.x - 4)) <= 0.5,
        `collection at the cap: the field ends 4 px before Grid / Graph (${field.right} for ${controls.x})`);
      assert.ok(field.right <= field.limit.right + 0.5, "collection at the cap: the field ends inside the place");
    } else {
      assert.ok(Math.abs(field.right - (field.limit.left - 4)) <= 0.5, "open card at the cap: the field ends at the room up to ⋯");
    }
    assert.equal(field.paddingRight, 8, `${label} at the cap: 8 px after the text`);
    assert.ok(field.textRight <= field.right - 8 + 1, `${label} at the cap: the last glyph keeps 8 px from the field's edge`);
    console.log(`PASS 1200 ${label}: the rename field follows its text, ${Math.round(opened)} to ${Math.round(field.width)} px at the cap, 8 px after the last glyph`);
    await page.keyboard.press("Escape");
    await page.locator(`[data-${marker}]`).waitFor();
  }
  await page.evaluate(() => { window.auditOpenCard(null); window.auditCollapse(false); });

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

  // The chrome's one height (SPEC_TABS.md, В83): the second row steps as
  // the row, a sidebar table row with its line.
  await page.setViewportSize({ width: 760, height: 700 });
  row = await read();
  assert.equal(row.fit, "two", "760: two rows");
  assert.equal(row.bar.bottom - row.bar.top, 40, "760: the second row and its line make 40");
  assert.equal(row.mainTop, row.bar.bottom, "760: the feed moves down by the second row");
  await page.setViewportSize({ width: 740, height: 700 });
  console.log("PASS 760: the second row steps 40");

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
