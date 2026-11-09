// The Connected / Disconnect / Connect button of a sidebar row in headless
// Chromium: 8px from the row on all four sides and one width in every state,
// at 1x and 2x. Starts and stops its own Vite.
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { chromium, webkit } from "playwright";
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
      import {useSidebarKeyboardFocus} from "/src/hooks/useSidebarKeyboardFocus.ts";
      import {buildSidebarSearchNavigationRows} from "/src/lib/sidebarSearch.ts";
      import {setCollectionMemberships,setHoveredCard,setSelectedCards} from "/src/lib/collectionHover.ts";
      import {writeSidebarWidth} from "/src/lib/sidebarWidth.ts";
      import {TooltipProvider} from "/src/components/ui/tooltip.tsx";
      import "/src/styles/global.css";
      const noop=()=>{};
      const TAGS=[{tag:"alpha",count:18},{tag:"beta",count:7},{tag:"gamma",count:3}];
      // A card open, the rows' buttons at work; ?feed, none open.
      const FEED=new URLSearchParams(location.search).has("feed");
      // In the feed with cards selected, the rows edit the selection (С6): alpha holds
      // both of them, gamma one.
      const SELECTION=new URLSearchParams(location.search).has("selection");
      const GRAPH=new URLSearchParams(location.search).has("graph");
      if(SELECTION){
        setCollectionMemberships([{block_id:7,tag:"alpha"},{block_id:8,tag:"alpha"},{block_id:7,tag:"gamma"}]);
        setSelectedCards([{id:7,slug:"one"},{id:8,slug:"two"}]);
      }
      window.hoverCard=()=>{setCollectionMemberships([{block_id:7,tag:"alpha"}]);setHoveredCard(7);};
      writeSidebarWidth((new URLSearchParams(location.search).get("width")??"600")+"px");
      function Fixture(){
        const [linked,setLinked]=React.useState(["alpha","gamma"]);
        const [query,setQuery]=React.useState("");
        const [order,setOrder]=React.useState(TAGS);
        const fieldRef=React.useRef(null);
        const focus=useSidebarKeyboardFocus({
          rows:buildSidebarSearchNavigationRows(order,query),currentRowKey:"tag:alpha",feedOnScreen:!GRAPH,cardOpen:!FEED,sidebarShown:true,
          openedForKeyboard:false,setOpenedForKeyboard:noop,
          filterQuery:query,setFilterQuery:setQuery,filterFieldRef:fieldRef,
          moveRow:(rowKey,direction)=>{
            const index=order.findIndex((entry)=>"tag:"+entry.tag===rowKey),next=order[index+direction];
            if(index===-1||!next)return false;
            const moved=[...order];moved[index]=next;moved[index+direction]=order[index];
            setOrder(moved);
            return true;
          }
        });
        window.keyboardFocus=focus;
        return React.createElement(MemoryRouter,{initialEntries:["/channel/alpha"]},React.createElement(TooltipProvider,null,
          React.createElement("input",{
            ref:fieldRef,"aria-label":"Find or create collection",value:query,
            onChange:(event)=>setQuery(event.target.value),
            onFocus:focus.fieldFocused,onBlur:focus.fieldBlurred,
            onKeyDown:(event)=>{
              if(event.key==="Escape"&&focus.fieldEscape())event.preventDefault();
              if(event.key==="ArrowDown"){event.preventDefault();focus.fieldDown();}
            }
          }),
          React.createElement(DndContext,null,React.createElement(Sidebar,{
            width:600,collapsed:false,widthAnimating:false,
            orderedTags:order,searchQuery:query,
            channelPreviews:new Map(),totalBlocks:18,isDropDragging:false,isCreatingChannel:false,
            onSetCreatingChannel:noop,onDeleteTag:noop,onRenameTag:noop,onCreateChannel:noop,
            linkedBlockSlug:FEED?null:"audit",linkedTags:linked,
            onBatchSetTag:SELECTION?noop:undefined,
            onToggleLinkedTag:(_slug,tag,has)=>setLinked(has?linked.filter((t)=>t!==tag):[...linked,tag]),
            keyboardFocusRowKey:focus.rowKey
          }))));
      }
      createRoot(document.getElementById("root")).render(React.createElement(Fixture));`;
  },
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url.split("?")[0] !== route) return next();
      res.setHeader("Content-Type", "text/html");
      const query = new URL(req.url, "http://audit").searchParams;
      const width = query.get("width") ?? "600";
      const theme = query.get("theme") ?? "light";
      res.end(await server.transformIndexHtml(req.url, `<html data-theme="${theme}" style="--sidebar-width:${width}px"><body class="bg-sidebar"><div id="root" style="height:600px"></div><script type="module" src="${entry}"></script></body></html>`));
    });
  },
}]);

/** The label the button shows: of its stacked labels, the one fully shown;
 *  nothing while the button itself is not fully shown. The words stand in
 *  their own box beside the Contents list's plus (Sidebar.tsx). */
function shownLabel(button) {
  if (getComputedStyle(button).opacity !== "1") return "";
  const label = button.querySelector("[data-sidebar-link-label]");
  const stack = label.firstElementChild;
  if (!stack) return label.textContent.trim();
  return [...stack.children]
    .filter((label) => getComputedStyle(label).opacity === "1")
    .map((label) => label.textContent.trim())
    .join(" + ");
}

/** Colour of a pixel of a decoded screenshot, by page coordinates at 1x. */
function pixel(png, clip, x, y) {
  const index = (Math.round(y - clip.y) * png.width + Math.round(x - clip.x)) * 4;
  return [png.data[index], png.data[index + 1], png.data[index + 2]];
}
const near = (first, second, by = 2) => first.every((channel, index) => Math.abs(channel - second[index]) <= by);

/**
 * No box around the button's words, by pixels in WebKit, the app's engine, in both
 * themes (SPEC_KEYBOARD.md, М5). Where the words stand bare (Contents) what masks the
 * dotted leader takes the colour of the ground under it: the plate under the keyboard's
 * focus, the panel otherwise, and the dots still stop before the word. Where they stand
 * on a real button (Plain, the table) its face stands as far from the plate as from the
 * panel. Every sample is reported as it fails.
 */
/** A first character typed on a row, in the engine the app runs on (SPEC_KEYBOARD.md,
 *  «Ввод текста в меню»). A headless browser presses only the keys of the US layout,
 *  so the Russian one comes as the event its key sends; what follows it is real typing. */
async function typingOnARow() {
  const engine = await webkit.launch({ headless: true });
  try {
    const page = await engine.newPage({ viewport: { width: 1000, height: 700 } });
    const field = page.getByRole("textbox", { name: "Find or create collection" });
    const row = () => page.evaluate(() => window.keyboardFocus.rowKey);
    const inField = () => field.evaluate((input) => document.activeElement === input);
    const enterRow = async () => {
      await page.evaluate(() => window.keyboardFocus.enter());
      await page.waitForFunction(() => window.keyboardFocus.rowKey === "tag:alpha");
    };
    await page.goto(new URL(`${route}?feed`, vite.origin).href);
    await page.waitForSelector('[data-sidebar-row-key="tag:alpha"]', { timeout: COLD_START_MS });
    await page.mouse.move(900, 650);

    await enterRow();
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "б", code: "Comma", bubbles: true, cancelable: true,
      }));
    });
    await page.waitForFunction(() => window.keyboardFocus.rowKey === null);
    assert.equal(await inField(), true, "a Russian letter takes the focus to the field");
    assert.equal(await field.inputValue(), "б", "the Russian letter is in the field, once");
    await page.keyboard.press("KeyA");
    assert.equal(await field.inputValue(), "бa", "the next key goes on in the field, after the first");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => window.keyboardFocus.rowKey === "tag:alpha");
    assert.equal(await field.inputValue(), "", "Escape clears the query");
    assert.equal(await inField(), false, "Escape takes the caret out of the field");
    console.log("PASS WebKit: a first Russian letter on a row, the next key after it, and Escape back");

    await page.keyboard.press("KeyB");
    assert.equal(await inField(), true, "a real key takes the focus to the field");
    assert.equal(await field.inputValue(), "b", "the real key is in the field, once");
    await page.keyboard.press("KeyE");
    assert.equal(await field.inputValue(), "be", "typing goes on");
    assert.equal(await row(), null, "no row holds the focus with the field");
    await page.keyboard.press("ArrowDown");
    await page.waitForFunction(() => window.keyboardFocus.rowKey === "tag:beta");
    assert.equal(await inField(), false, "ArrowDown takes the caret out of the field");
    await page.keyboard.press("KeyT");
    assert.equal(await field.inputValue(), "bet", "a character on a filtered row goes on with the query");
    assert.equal(await inField(), true, "and the focus is in the field");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("KeyX");
    assert.equal(await field.inputValue(), "bext", "the arrows are the caret's in the field");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => window.keyboardFocus.rowKey === "tag:alpha");
    console.log("PASS WebKit: real keys on a row, in the field and on a filtered row");
    await page.close();
  } finally {
    await engine.close();
  }
}

/** What lights up is exactly what a click or a key does (SPEC_CARD_STATES.md, С7.10;
 *  SPEC_KEYBOARD.md, М5): the name or the button, never both. Computed colours, in the
 *  engine the app runs on. */
async function eitherPart() {
  const engine = await webkit.launch({ headless: true });
  const opened = async (look, width, query) => {
    const page = await engine.newPage({ viewport: { width: 1000, height: 700 } });
    await page.addInitScript({ content: `
      localStorage.setItem("mine.sidebar.listStyle", ${JSON.stringify(look === "contents" ? "contents" : "plain")});
      window.shownLabel = ${shownLabel.toString()};
    ` });
    await page.goto(new URL(`${route}?width=${width}${query}`, vite.origin).href);
    await page.waitForSelector('[data-sidebar-row-key="tag:alpha"] [data-sidebar-link-action]', { timeout: COLD_START_MS });
    await page.mouse.move(900, 650);
    await page.waitForTimeout(300);
    return page;
  };
  const read = (page, key) => page.evaluate((selector) => {
    const row = document.querySelector(selector);
    const button = row.querySelector("[data-sidebar-link-action]");
    const label = button?.querySelector("[data-sidebar-link-label]");
    const stack = label?.firstElementChild;
    const shown = stack ? [...stack.children].find((word) => getComputedStyle(word).opacity === "1") : label;
    const press = row.querySelector('[data-sidebar-link-word="press"]');
    return {
      name: getComputedStyle(row.querySelector("[data-sidebar-name-text]")).color,
      label: button ? window.shownLabel(button) : null,
      word: shown ? getComputedStyle(shown).color : null,
      pressWord: press ? getComputedStyle(press).color : null,
      image: button ? getComputedStyle(button).backgroundImage : null,
      marked: button?.hasAttribute("data-sidebar-link-pointer") ?? false,
      pill: getComputedStyle(row.querySelector("[data-sidebar-row-connected-pill]")).color,
    };
  }, `[data-sidebar-row-key="${key}"]`);
  const moveTo = async (page, x, y) => {
    await page.mouse.move(x - 2, y);
    await page.mouse.move(x, y);
  };
  const overName = async (page, key) => {
    const row = await page.locator(`[data-sidebar-row-key="${key}"]`).boundingBox();
    await moveTo(page, row.x + 60, row.y + row.height / 2);
  };
  const overButton = async (page, key) => {
    const box = await page.locator(`[data-sidebar-row-key="${key}"] [data-sidebar-link-action]`).boundingBox();
    await moveTo(page, box.x + box.width / 2, box.y + box.height / 2);
  };
  const seen = async (page, key) => {
    await page.waitForTimeout(300);
    return read(page, key);
  };
  try {
    for (const [look, width] of [["contents", 320], ["plain", 320], ["table", 600]]) {
      // A card open: alpha current and connected, gamma connected, beta neither.
      const page = await opened(look, width, "");
      const rest = {
        current: await read(page, "tag:alpha"),
        other: await read(page, "tag:gamma"),
        plain: await read(page, "tag:beta"),
        everything: await read(page, "all"),
      };
      const bright = rest.current.name;
      const muted = rest.plain.name;
      const shows = (seen_, name, label, what) => {
        assert.equal(seen_.name, name, `${look}: the name, ${what}`);
        assert.equal(seen_.label, label, `${look}: the word, ${what}`);
      };

      await overName(page, "tag:gamma");
      let now = await seen(page, "tag:gamma");
      shows(now, bright, "Connected", "another connected row, over the left part");
      assert.equal(now.word, rest.other.word, `${look}: Connected stays muted over the left part`);
      assert.equal(now.image, rest.other.image, `${look}: the button stays at rest over the left part`);

      await overButton(page, "tag:gamma");
      assert.equal((await read(page, "tag:gamma")).marked, true, `${look}: the button answers at once`);
      now = await seen(page, "tag:gamma");
      shows(now, muted, "Disconnect", "another connected row, over the right part");
      assert.equal(now.word, rest.other.pressWord, `${look}: Disconnect has its own colour`);
      assert.notEqual(now.word, muted, `${look}: Disconnect is not muted`);
      if (look !== "contents") assert.notEqual(now.image, rest.other.image, `${look}: the button's face answers`);

      await overName(page, "tag:gamma");
      assert.equal((await read(page, "tag:gamma")).marked, false, `${look}: the button lets go at once`);
      now = await seen(page, "tag:gamma");
      shows(now, bright, "Connected", "back over the left part");

      await overButton(page, "tag:alpha");
      shows(await seen(page, "tag:alpha"), bright, "Disconnect", "the current row, over the right part");
      await overName(page, "tag:alpha");
      shows(await seen(page, "tag:alpha"), bright, "Connected", "the current row, over the left part");

      await overName(page, "tag:beta");
      now = await seen(page, "tag:beta");
      shows(now, bright, "Connect", "a row that is not connected, over the left part");
      assert.equal(now.image, rest.plain.image, `${look}: Connect stays in its normal look over the left part`);
      assert.equal(now.word, rest.plain.word, `${look}: Connect stays in its normal colour over the left part`);
      await overButton(page, "tag:beta");
      const pressed = await seen(page, "tag:beta");
      shows(pressed, muted, "Connect", "a row that is not connected, over the right part");
      if (look === "contents") assert.equal(pressed.word, bright, "contents: Connect is bright over it");
      else assert.notEqual(pressed.image, rest.plain.image, `${look}: Connect's face answers over it`);

      // The keyboard's focus lights what Enter presses, the same way; the name stays quiet.
      await page.mouse.move(900, 650);
      await page.waitForTimeout(300);
      await page.keyboard.press("ArrowLeft");
      await page.waitForFunction(() => window.keyboardFocus.rowKey === "tag:alpha");
      await page.keyboard.press("ArrowDown");
      await page.waitForFunction(() => window.keyboardFocus.rowKey === "tag:beta");
      now = await seen(page, "tag:beta");
      shows(now, muted, "Connect", "under the keyboard's focus");
      assert.equal(now.word, pressed.word, `${look}: Connect under the keyboard is coloured as under the pointer`);
      if (look !== "contents") assert.notEqual(now.image, rest.plain.image, `${look}: Connect's face answers the keyboard`);
      await page.keyboard.press("ArrowDown");
      await page.waitForFunction(() => window.keyboardFocus.rowKey === "tag:gamma");
      now = await seen(page, "tag:gamma");
      shows(now, muted, "Disconnect", "a connected row under the keyboard's focus");
      assert.equal(now.word, rest.other.pressWord, `${look}: Disconnect keeps its colour under the keyboard`);
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("ArrowUp");
      await page.waitForFunction(() => window.keyboardFocus.rowKey === "all");
      now = await seen(page, "all");
      assert.equal(now.label, null, `${look}: Everything has no button`);
      assert.equal(now.name, rest.everything.name, `${look}: Everything's name lights nothing`);
      assert.equal(now.pill, rest.everything.pill, `${look}: Everything's Connected lights nothing`);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => window.keyboardFocus.rowKey === null);

      // A pointer at rest does not answer (С7.5): the keyboard took the list from it.
      await overButton(page, "tag:gamma");
      await page.waitForTimeout(300);
      await page.keyboard.press("ArrowLeft");
      await page.waitForFunction(() => window.keyboardFocus.rowKey === "tag:alpha");
      now = await seen(page, "tag:gamma");
      shows(now, muted, "Connected", "with the pointer at rest on the button and the keyboard elsewhere");
      await page.close();

      // The selection's editor in the feed: the same two parts.
      const selection = await opened(look, width, "&feed&selection");
      const quiet = (await read(selection, "tag:beta")).name;
      const lit = (await read(selection, "tag:alpha")).name;
      await overName(selection, "tag:gamma");
      shows(await seen(selection, "tag:gamma"), lit, "1/2", "a part of the selection, over the left part");
      await overButton(selection, "tag:gamma");
      shows(await seen(selection, "tag:gamma"), quiet, "Connect", "a part of the selection, over the right part");
      await overName(selection, "tag:alpha");
      shows(await seen(selection, "tag:alpha"), lit, "Connected", "the whole selection, over the left part");
      await overButton(selection, "tag:alpha");
      shows(await seen(selection, "tag:alpha"), lit, "Disconnect", "the whole selection on the current row, over the right part");
      await overName(selection, "tag:beta");
      shows(await seen(selection, "tag:beta"), lit, "Connect", "none of the selection, over the left part");
      await overButton(selection, "tag:beta");
      shows(await seen(selection, "tag:beta"), quiet, "Connect", "none of the selection, over the right part");
      await selection.close();
      console.log(`PASS ${look}: the name or the button answers, never both, under the pointer, the keyboard and a selection`);
    }
  } finally {
    await engine.close();
  }
}

/** Under the keyboard's focus nothing moves (SPEC_KEYBOARD.md, М5; user's decision of
 *  07.11.2026): measured in the first frame after a key, by the page itself. The name lights
 *  in the feed and on the graph, and stays quiet over an open card. */
async function keyboardAtOnce() {
  const engine = await webkit.launch({ headless: true });
  const opened = async (look, query) => {
    const page = await engine.newPage({ viewport: { width: 1000, height: 700 } });
    await page.addInitScript({ content: `
      localStorage.setItem("mine.sidebar.listStyle", ${JSON.stringify(look === "contents" ? "contents" : "plain")});
      window.shownLabel = ${shownLabel.toString()};
      /** What a row shows, and what still runs on its name, its button and all inside it. */
      window.readRow = (key) => {
        const row = document.querySelector('[data-sidebar-row-key="' + key + '"]');
        const button = row.querySelector("[data-sidebar-link-action]");
        const icon = row.querySelector("[data-sidebar-link-icon]");
        const label = row.querySelector("[data-sidebar-link-label]");
        const running = [
          ...row.querySelector("[data-sidebar-name-text]").closest("[data-sidebar-row-text]").getAnimations(),
          ...(button ? button.getAnimations({ subtree: true }) : []),
        ].map((animation) => animation.transitionProperty ?? animation.animationName);
        return {
          name: getComputedStyle(row.querySelector("[data-sidebar-name-text]")).color,
          label: button ? window.shownLabel(button) : null,
          word: label ? getComputedStyle(label).translate : null,
          mark: icon ? getComputedStyle(icon).opacity : null,
          plate: getComputedStyle(row).backgroundImage !== "none",
          running,
        };
      };
      /** A key, and the rows as they stand in the first frame after it. */
      window.firstFrame = (key, rows) => new Promise((resolve) => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        requestAnimationFrame(() => resolve(Object.fromEntries(rows.map((rowKey) => [rowKey, window.readRow(rowKey)]))));
      });
    ` });
    await page.goto(new URL(`${route}?width=${look === "table" ? 600 : 320}${query}`, vite.origin).href);
    await page.waitForSelector('[data-sidebar-row-key="tag:alpha"]', { timeout: COLD_START_MS });
    await page.mouse.move(900, 650);
    // The marks turn once as the page loads, on the stack's spring.
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
    return page;
  };
  const step = (page, key, rows) => page.evaluate(([keyName, rowKeys]) => window.firstFrame(keyName, rowKeys), [key, rows]);
  try {
    for (const look of ["contents", "plain", "table"]) {
      // A card open: the button answers at once, and the name stays quiet.
      const page = await opened(look, "");
      const rest = await page.evaluate(() => ["tag:alpha", "tag:beta", "tag:gamma"].map((key) => window.readRow(key)));
      const [bright, muted] = [rest[0].name, rest[1].name];
      const still = (seen, what) => {
        for (const [rowKey, row] of Object.entries(seen)) {
          assert.deepEqual(row.running, [], `${look}: ${rowKey} runs nothing in the first frame, ${what}`);
        }
      };
      let seen = await step(page, "ArrowLeft", ["tag:alpha"]);
      still(seen, "as the focus arrives");
      assert.equal(seen["tag:alpha"].label, "Disconnect", `${look}: the word is in place as the focus arrives`);
      seen = await step(page, "ArrowDown", ["tag:alpha", "tag:beta"]);
      still(seen, "on an arrow step");
      assert.equal(seen["tag:alpha"].label, "Connected", `${look}: the word it left is back at once`);
      assert.equal(seen["tag:beta"].label, "Connect", `${look}: the word it reached is there at once`);
      assert.equal(seen["tag:beta"].name, muted, `${look}: a card open, the name stays quiet`);
      assert.equal(seen["tag:beta"].plate, true, `${look}: a card open, the plate is there`);
      if (look === "contents") {
        assert.equal(seen["tag:beta"].mark, "1", "contents: the mark is in place at once");
        assert.equal(seen["tag:alpha"].mark, "0", "contents: the mark it left is gone at once");
        assert.notEqual(seen["tag:beta"].word, seen["tag:alpha"].word, "contents: the word has stepped aside at once");
      }
      const settled = await page.evaluate(() => window.readRow("tag:beta"));
      seen = await step(page, "ArrowDown", ["tag:beta", "tag:gamma"]);
      still(seen, "on the next step");
      assert.equal(seen["tag:gamma"].label, "Disconnect", `${look}: Disconnect is there at once`);
      assert.equal(seen["tag:gamma"].name, muted, `${look}: a connected row's name stays quiet too`);
      seen = await step(page, "ArrowUp", ["tag:beta", "tag:gamma"]);
      assert.deepEqual(seen["tag:beta"], settled, `${look}: the first frame is the settled one`);
      // ⌘⇧↓ moves the row in the first frame, with nothing running on it (М11).
      const moved = await page.evaluate(() => new Promise((resolve) => {
        window.dispatchEvent(new KeyboardEvent("keydown", {
          key: "ArrowDown", metaKey: true, shiftKey: true, bubbles: true, cancelable: true,
        }));
        requestAnimationFrame(() => {
          const row = document.querySelector('[data-sidebar-row-key="tag:beta"]');
          resolve({
            order: [...document.querySelectorAll('[data-sidebar-row-key^="tag:"]')].map((node) => node.dataset.sidebarRowKey),
            running: row.getAnimations({ subtree: true }).map((animation) => animation.transitionProperty ?? animation.animationName),
            transform: getComputedStyle(row).transform,
            focused: row.getAttribute("data-sidebar-row-keyboard-focus"),
          });
        });
      }));
      assert.deepEqual(moved.order, ["tag:alpha", "tag:gamma", "tag:beta"], `${look}: the row moved in the first frame`);
      assert.deepEqual(moved.running, [], `${look}: nothing runs on the moved row`);
      assert.equal(moved.transform, "none", `${look}: the moved row stands in its place`);
      assert.equal(moved.focused, "true", `${look}: the focus stays on the moved row`);
      await page.evaluate(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", {
          key: "ArrowUp", metaKey: true, shiftKey: true, bubbles: true, cancelable: true,
        }));
      });
      await page.waitForFunction(() => document.querySelectorAll('[data-sidebar-row-key^="tag:"]')[1]?.dataset.sidebarRowKey === "tag:beta");
      seen = await step(page, "Escape", ["tag:beta", "tag:gamma"]);
      still(seen, "as the focus leaves");
      assert.equal(seen["tag:beta"].plate, false, `${look}: the plate is gone at once`);

      // The pointer's own motion is as it was, and no mark turns again as it returns.
      const box = await page.locator('[data-sidebar-row-key="tag:beta"] [data-sidebar-link-action]').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const moving = await page.evaluate(() => window.readRow("tag:beta").running);
      assert.ok(moving.some((name) => name === "opacity" || name === "translate"), `${look}: the pointer's answer still moves: ${moving}`);
      assert.ok(!moving.some((name) => String(name).startsWith("sidebar-link-icon")), `${look}: no mark turns again: ${moving}`);
      await page.close();

      // The feed and the graph: Enter opens the collection, and the name lights at once.
      for (const [surface, query] of [["feed", "&feed"], ["graph", "&feed&graph"]]) {
        const quiet = await opened(look, query);
        const [lit, dim] = await quiet.evaluate(() => [window.readRow("tag:alpha").name, window.readRow("tag:beta").name]);
        assert.notEqual(lit, dim, `${look} ${surface}: another row's name is muted at rest`);
        if (surface === "feed") await quiet.evaluate(() => window.keyboardFocus.enter());
        else await step(quiet, "ArrowLeft", ["tag:alpha"]);
        await quiet.waitForFunction(() => window.keyboardFocus.rowKey === "tag:alpha");
        seen = await step(quiet, "ArrowDown", ["tag:alpha", "tag:beta"]);
        still(seen, `in the ${surface}`);
        assert.equal(seen["tag:beta"].name, lit, `${look} ${surface}: the name lights in the first frame`);
        assert.equal(seen["tag:beta"].plate, true, `${look} ${surface}: the plate is there`);
        assert.equal(seen["tag:alpha"].name, lit, `${look} ${surface}: the current row stays bright`);
        seen = await step(quiet, "ArrowUp", ["tag:alpha", "tag:beta"]);
        assert.equal(seen["tag:beta"].name, dim, `${look} ${surface}: the name it left is muted in the first frame`);
        seen = await step(quiet, "ArrowUp", ["all", "tag:alpha"]);
        assert.equal(seen.all.name, lit, `${look} ${surface}: Everything lights too, as Enter opens it`);
        seen = await step(quiet, "ArrowDown", ["tag:alpha"]);
        seen = await step(quiet, "ArrowDown", ["tag:beta"]);
        seen = await step(quiet, "Escape", ["tag:beta"]);
        assert.equal(seen["tag:beta"].name, dim, `${look} ${surface}: muted in the first frame after Escape`);
        await quiet.close();
      }
      console.log(`PASS ${look}: under the keyboard's focus nothing moves, and the name lights where Enter opens`);
    }
  } finally {
    await engine.close();
  }
}

async function pixelsAroundTheWord() {
  const engine = await webkit.launch({ headless: true });
  const failures = [];
  try {
    for (const theme of ["dark", "light"]) {
      for (const [look, width] of [["contents", 320], ["plain", 320], ["table", 600]]) {
        const page = await engine.newPage({ viewport: { width: 1000, height: 700 } });
        await page.addInitScript({ content: `
          localStorage.setItem("mine.sidebar.listStyle", ${JSON.stringify(look === "contents" ? "contents" : "plain")});
          window.shownLabel = ${shownLabel.toString()};
        ` });
        await page.goto(new URL(`${route}?theme=${theme}&width=${width}`, vite.origin).href);
        await page.waitForSelector('[data-sidebar-row-key="tag:alpha"] [data-sidebar-link-action]', { timeout: COLD_START_MS });
        await page.mouse.move(900, 650);
        await page.waitForTimeout(300);

        /** The row's shot, its ground, and the pixels right around its shown word. */
        const look_ = async (key) => {
          const place = await page.evaluate((rowKey) => {
            const row = document.querySelector(`[data-sidebar-row-key="${rowKey}"]`);
            const button = row.querySelector("[data-sidebar-link-action]");
            const stack = button.querySelector("[data-sidebar-link-label]");
            const spans = stack.firstElementChild ? [...stack.firstElementChild.children] : [];
            const word = spans.find((one) => getComputedStyle(one).opacity === "1") ?? stack;
            const range = document.createRange();
            range.selectNodeContents(word);
            const text = range.getBoundingClientRect();
            const label = stack.getBoundingClientRect();
            const box = row.getBoundingClientRect();
            return {
              word: word.textContent,
              text: { left: text.left, right: text.right, top: text.top, bottom: text.bottom },
              label: { left: label.left, right: label.right, top: label.top, bottom: label.bottom },
              row: { x: box.left, y: box.top, width: box.width, height: box.height },
            };
          }, key);
          const clip = { x: Math.floor(place.row.x), y: Math.floor(place.row.y), width: Math.ceil(place.row.width), height: Math.ceil(place.row.height) };
          const png = PNG.sync.read(await page.screenshot({ clip }));
          const ground = pixel(png, clip, place.row.x + 4, place.row.y + 4);
          const { text } = place;
          const middle = (text.top + text.bottom) / 2;
          const around = [
            pixel(png, clip, text.left - 2, middle),
            pixel(png, clip, text.right + 2, middle),
            pixel(png, clip, text.left - 2, text.top),
            pixel(png, clip, text.right + 2, text.top),
            pixel(png, clip, text.left - 2, text.bottom - 1),
            pixel(png, clip, text.right + 2, text.bottom - 1),
          ];
          // The leader's dots, along the word's last line, left of its mask.
          let dots = 0;
          for (let x = Math.round(place.label.left) - 40; x < Math.round(place.label.left) - 1; x += 1) {
            for (let y = Math.round(text.top); y < Math.round(text.bottom); y += 1) {
              if (!near(pixel(png, clip, x, y), ground, 6)) dots += 1;
            }
          }
          return { word: place.word, ground, around, dots };
        };

        const expectBare = (label, seen) => {
          for (const sample of seen.around) {
            if (!near(sample, seen.ground)) failures.push(`${theme} ${look} ${label}: ${seen.word}: ${sample} around the word against ${seen.ground} under it`);
          }
          if (seen.dots === 0) failures.push(`${theme} ${look} ${label}: ${seen.word}: no leader before the word`);
        };
        const distance = (one, two) => one.map((channel, index) => channel - two[index]);

        // At rest: Connected on the current row and muted on another, Connect on a plain one.
        const rest = { current: await look_("tag:alpha"), other: await look_("tag:gamma"), plain: await look_("tag:beta") };

        const focusOn = async (key) => {
          await page.keyboard.press("ArrowLeft");
          if (key === "tag:beta") await page.keyboard.press("ArrowDown");
          if (key === "tag:gamma") {
            await page.keyboard.press("ArrowDown");
            await page.keyboard.press("ArrowDown");
          }
          await page.waitForFunction((rowKey) => window.keyboardFocus.rowKey === rowKey, key);
          await page.waitForTimeout(300);
        };
        const leave = async () => {
          await page.keyboard.press("Escape");
          await page.waitForFunction(() => window.keyboardFocus.rowKey === null);
          await page.waitForTimeout(300);
        };
        const hover = async (key) => {
          const box = await page.locator(`[data-sidebar-row-key="${key}"] [data-sidebar-link-action]`).boundingBox();
          await page.mouse.move(box.x + box.width / 2 - 2, box.y + box.height / 2);
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(300);
          const seen = await look_(key);
          await page.mouse.move(900, 650);
          await page.waitForTimeout(300);
          return seen;
        };

        for (const key of ["tag:beta", "tag:alpha", "tag:gamma"]) {
          await focusOn(key);
          const focused = await look_(key);
          await leave();
          const pointed = await hover(key);
          const plateSeen = !near(focused.ground, pointed.ground, 0);
          if (!plateSeen) failures.push(`${theme} ${look} ${key}: no plate under the keyboard's focus`);
          if (look === "contents") {
            expectBare("under the keyboard", focused);
            expectBare("under the pointer", pointed);
          } else {
            // The real button's face: as far from the plate as from the panel.
            const onPlate = distance(focused.around[0], focused.ground);
            const onPanel = distance(pointed.around[0], pointed.ground);
            if (!near(onPlate, onPanel)) failures.push(`${theme} ${look} ${key}: the face stands ${onPlate} from the plate, ${onPanel} from the panel`);
          }
        }
        if (look === "contents") {
          expectBare("at rest", rest.current);
          expectBare("at rest", rest.other);
        }
        await page.close();
      }
      console.log(`PASS ${theme}: pixels around the words sampled in Contents, Plain and the table`);
    }
  } finally {
    await engine.close();
  }
  assert.deepEqual(failures, [], `boxes around the words:\n${failures.join("\n")}`);
  console.log("PASS no box around the words, under the keyboard and under the pointer, in both themes");
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

  const rowOf = (key) => `[data-sidebar-row-key="${key}"]`;
  const measure = (page, key) => page.evaluate((selector) => {
    const row = document.querySelector(selector);
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return [rect.left, rect.top, rect.width, rect.height];
    };
    const buttons = [...row.querySelectorAll("button, [data-sidebar-row-connected-pill]")];
    return {
      shown: buttons.filter((button) => getComputedStyle(button).visibility === "visible" && getComputedStyle(button).opacity !== "0").length,
      name: box(row.querySelector("[data-sidebar-name-text]")),
      cell: box(row.querySelector("[data-sidebar-name-cell]")),
      rail: box(row.querySelector("[data-sidebar-preview-rail]")),
      row: box(row),
      button: buttons.map(box),
      count: getComputedStyle(row.querySelector("[data-sidebar-meta-count]")).opacity,
      plate: getComputedStyle(row).backgroundImage !== "none",
      text: getComputedStyle(row.querySelector("[data-sidebar-name-text]")).color,
    };
  }, rowOf(key));
  const geometry = ({ name, cell, rail, row, button }) => ({ name, cell, rail, row, button });
  const settle = (page) => page.waitForTimeout(250);

  // In the feed Enter opens the row and presses nothing, so the focused row shows no
  // button (SPEC_KEYBOARD.md, М5). Nothing moves by a pixel.
  {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.goto(new URL(`${route}?feed`, vite.origin).href);
    await page.waitForSelector(rowOf("tag:alpha"), { timeout: COLD_START_MS });
    await page.evaluate(() => window.hoverCard());
    await page.mouse.move(900, 650);
    await settle(page);
    const rest = await measure(page, "tag:alpha");
    assert.equal(rest.shown, 1, "the row of the card under the keyboard shows Connected at rest");
    assert.equal(rest.plate, false);

    await page.evaluate(() => window.keyboardFocus.enter());
    await page.waitForSelector(`${rowOf("tag:alpha")}[data-sidebar-row-keyboard-focus="true"]`);
    await settle(page);
    const focused = await measure(page, "tag:alpha");
    assert.equal(focused.shown, 0, "no button under the keyboard's focus in the feed");
    assert.equal(focused.plate, true);
    assert.equal(focused.count, "1", "the count stands where the button stood");
    assert.equal(focused.text, rest.text, "the current row's name stays bright");
    assert.deepEqual(geometry(focused), geometry(rest), "nothing moves as the focus arrives");
    console.log("PASS the feed: no button under the keyboard's focus, and nothing moves");

    await page.keyboard.press("ArrowDown");
    await page.waitForSelector(`${rowOf("tag:beta")}[data-sidebar-row-keyboard-focus="true"]`);
    await settle(page);
    const back = await measure(page, "tag:alpha");
    assert.equal(back.shown, 1, "the first row's button is back on the next row");
    assert.deepEqual(geometry(back), geometry(rest), "nothing moves as the focus leaves");
    console.log("PASS the feed: the button is back once the focus leaves the row");
    await page.close();
  }

  // Over an open card Enter presses the button, and the focused row shows it exactly
  // as under the pointer, the plate under it changing nothing (М5).
  {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.addInitScript({ content: `window.shownLabel = ${shownLabel.toString()};` });
    await page.goto(new URL(route, vite.origin).href);
    await page.getByRole("button", { name: "Disconnect alpha" }).waitFor({ timeout: COLD_START_MS });
    const face = (key) => page.evaluate((selector) => {
      const button = document.querySelector(selector).querySelector("[data-sidebar-link-action]");
      const look = (style) => ({
        background: style.backgroundColor,
        image: style.backgroundImage,
        shadow: style.boxShadow,
        color: style.color,
        border: style.borderColor,
      });
      const rect = button.getBoundingClientRect();
      return {
        label: window.shownLabel(button),
        visibility: getComputedStyle(button).visibility,
        opacity: getComputedStyle(button).opacity,
        box: [rect.left, rect.top, rect.width, rect.height],
        own: look(getComputedStyle(button)),
        before: look(getComputedStyle(button, "::before")),
        after: look(getComputedStyle(button, "::after")),
      };
    }, rowOf(key));
    const away = async () => {
      await page.mouse.move(900, 650);
      await settle(page);
    };
    const underPointer = async (key) => {
      const box = await page.locator(`${rowOf(key)} [data-sidebar-link-action]`).boundingBox();
      await page.mouse.move(box.x + box.width / 2 - 2, box.y + box.height / 2);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await settle(page);
      const seen = await face(key);
      await away();
      return seen;
    };
    /** The focus on `key`, walked from the row it enters on. */
    const focusOn = async (key) => {
      await page.keyboard.press("ArrowLeft");
      await page.waitForFunction(() => window.keyboardFocus.rowKey !== null);
      if (key === "tag:beta") await page.keyboard.press("ArrowDown");
      if (key === "tag:gamma") {
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
      }
      if (key === "all") await page.keyboard.press("ArrowUp");
      await page.waitForFunction((rowKey) => window.keyboardFocus.rowKey === rowKey, key);
      await settle(page);
    };
    const leave = async () => {
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => window.keyboardFocus.rowKey === null);
      await settle(page);
    };

    await away();
    for (const [key, label] of [["tag:alpha", "Disconnect"], ["tag:beta", "Connect"]]) {
      const pointer = await underPointer(key);
      assert.equal(pointer.label, label);
      const rest = await measure(page, key);
      await focusOn(key);
      const keyboard = await face(key);
      // The state, the word and the place are the pointer's. The fills follow the plate
      // under them; the pixels below check how they stand on it.
      assert.deepEqual(
        { label: keyboard.label, visibility: keyboard.visibility, opacity: keyboard.opacity, box: keyboard.box, color: keyboard.own.color },
        { label: pointer.label, visibility: pointer.visibility, opacity: pointer.opacity, box: pointer.box, color: pointer.own.color },
        `${label}: the button's state and place are as under the pointer`,
      );
      const focused = await measure(page, key);
      assert.equal(focused.plate, true);
      assert.equal(focused.text, rest.text, "the name is no brighter");
      assert.deepEqual(geometry(focused), geometry(rest), "nothing moves as the focus arrives");
      await leave();
      console.log(`PASS a card open: ${label} under the keyboard's focus has the pointer's state and place`);
    }

    // Enter toggles and the button follows at once, the focus staying.
    await focusOn("tag:beta");
    assert.equal((await face("tag:beta")).label, "Connect");
    await page.keyboard.press("Enter");
    await page.waitForFunction((selector) => window.shownLabel(document.querySelector(selector).querySelector("[data-sidebar-link-action]")) === "Disconnect", rowOf("tag:beta"));
    assert.equal(await page.evaluate(() => window.keyboardFocus.rowKey), "tag:beta");
    await page.keyboard.press("Enter");
    await page.waitForFunction((selector) => window.shownLabel(document.querySelector(selector).querySelector("[data-sidebar-link-action]")) === "Connect", rowOf("tag:beta"));
    assert.equal(await page.evaluate(() => window.keyboardFocus.rowKey), "tag:beta");
    await leave();
    console.log("PASS a card open: Enter toggles, the button follows, the focus stays");

    // Everything's row keeps its Connected, and Enter does nothing there.
    await focusOn("all");
    assert.equal((await measure(page, "all")).shown, 1, "Connected stays on Everything");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => window.keyboardFocus.rowKey), "all");
    await leave();
    console.log("PASS a card open: Everything keeps Connected, and Enter does nothing");

    // With a card open only the current collection's row stays bright at rest; the
    // other connected rows are muted on the same button, and the pointer brightens them
    // (SPEC_CARD_STATES.md, С7.10).
    const colours = (key) => page.evaluate((selector) => {
      const row = document.querySelector(selector);
      const button = row.querySelector("[data-sidebar-link-action]");
      const style = getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      const connected = button.querySelector("[data-sidebar-link-connected]");
      return {
        name: getComputedStyle(row.querySelector("[data-sidebar-name-text]")).color,
        connected: connected ? getComputedStyle(connected).color : null,
        label: window.shownLabel(button),
        fill: {
          background: style.backgroundColor,
          image: style.backgroundImage,
          line: style.boxShadow,
          border: style.borderColor,
          radius: style.borderRadius,
          width: rect.width,
          height: rect.height,
        },
      };
    }, rowOf(key));
    await away();
    const current = await colours("tag:alpha");
    const other = await colours("tag:gamma");
    const plain = await colours("tag:beta");
    assert.notEqual(current.name, plain.name, "the current connected row's name is bright");
    assert.equal(current.label, "Connected");
    assert.equal(current.connected, current.name, "its Connected is as bright");
    assert.equal(other.name, plain.name, "another connected row's name is muted, as at rest in the list");
    assert.equal(other.label, "Connected");
    assert.equal(other.connected, plain.name, "its Connected is muted by the same token");
    assert.deepEqual(other.fill, current.fill, "the button's fill, line, radius and size do not change");
    console.log("PASS a card open: the current row bright, another connected row muted on the same button");

    const button = await page.locator(`${rowOf("tag:gamma")} [data-sidebar-link-action]`).boundingBox();
    await page.mouse.move(button.x + button.width / 2 - 2, button.y + button.height / 2);
    await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2);
    await settle(page);
    const hovered = await colours("tag:gamma");
    assert.equal(hovered.label, "Disconnect", "over the button it takes the hover's look");
    const hoveredFace = await face("tag:gamma");
    await away();
    const current2 = await underPointer("tag:alpha");
    assert.deepEqual(
      { own: hoveredFace.own, before: hoveredFace.before, after: hoveredFace.after, label: hoveredFace.label },
      { own: current2.own, before: current2.before, after: current2.after, label: current2.label },
      "the same hover look as the current row's",
    );
    assert.deepEqual(await colours("tag:gamma"), other, "and muted again as the pointer leaves");
    console.log("PASS a card open: that row's button answers the pointer, and is muted again after it");

    await focusOn("tag:gamma");
    const focusedOther = await colours("tag:gamma");
    assert.equal(focusedOther.name, plain.name, "the keyboard's focus does not brighten the name");
    await leave();
    await focusOn("tag:alpha");
    assert.equal((await colours("tag:alpha")).name, current.name, "the current row stays bright under it");
    await leave();
    console.log("PASS a card open: the keyboard's focus keeps the same colours");

    // Other rows, and the pointer's plate-less row, stay as they are.
    const beta = await page.locator(rowOf("tag:beta")).boundingBox();
    await page.mouse.move(beta.x + 40, beta.y + 10);
    await page.mouse.move(beta.x + 50, beta.y + 12);
    await settle(page);
    assert.equal((await measure(page, "tag:beta")).plate, false, "no plate under the pointer");
    console.log("PASS the pointer's row has no plate");
    await page.close();
  }

  await typingOnARow();
  await eitherPart();
  await keyboardAtOnce();
  await pixelsAroundTheWord();
} finally {
  await browser?.close();
  await vite.close();
}
