// The card's window at the three motion levels in headless WebKit, the engine
// of Mine's window (SPEC_MOTION_LEVELS.md, «Новая браузерная проверка окна
// карточки»): real layout, real compositor animations and real frames, which
// the jsdom tests cannot see. A stand page holds a feed of two cards and the
// real `CardPeek`; the level is written as `mine.motion` before the page
// loads. Every frame records the transform and the opacity of the window
// (`[data-card-peek-nudge]`, the one element Minimal moves) and of its scrim,
// read after the frame was produced. It checks the rise (ОУ2), the sink for
// each way of closing (ОУ3), the hint's step as the leaving's start with a
// press at rest, in the step and midway through it (ОУ4, rules 1–5), Off
// (ОУ8), Full's growth out of the card and back (О10, п. 1; О11, п. 4), the
// way to the full page and back on the three levels (О17, ОУ7), the
// system's flag with no stored level (НС3) and the level on the root before
// the first render of the three app pages (НС5). Starts and stops its own
// Vite.
import assert from "node:assert/strict";
import { webkit } from "playwright";
import { COLD_START_MS, startAuditVite } from "./audit-vite.mjs";

const VIEWPORT = { width: 1200, height: 800 };
/** CARD_PEEK_MARGIN_PX and CARD_PEEK_CENTER_SCALE (cardPeek.ts): the
 *  leaving's end, 40 px down at 95 %. */
const MARGIN_PX = 40;
const CENTER_SCALE = 0.95;
/** The hint's step, a sixth of the leaving. */
const NUDGE_SHARE = 1 / 6;
/** --motion-enter and --motion-exit. */
const ENTER_MS = 150;
const EXIT_MS = 100;
/** E, --motion-ease. */
const EASE = [0.22, 1, 0.36, 1];
/** --motion-move at Minimal: the way to and from the full page (ОУ7). */
const MOVE_MS = 150;
/** How far a box may lie from where it should be, px: the frame's pieces
 *  are written in whole and half pixels. */
const BOX_SLACK_PX = 0.75;
/** ОУ4, rule 1: how far a frame may lie off the line. */
const LINE_TOLERANCE = 0.002;
/** How far the clock a leaving starts on may lie from the frame's: the
 *  press reads the document timeline between frames, and a frame's place is
 *  read as the frame begins, both to a few milliseconds (ОУ4, rule 2). */
const CLOCK_SLACK_MS = 3;

const entry = "/card-peek-motion-audit-entry.js";

const STAND_PAGE = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {CardPeek} from '/src/components/CardPeek.tsx';
  import {installMotionLevel} from '/src/lib/motion.ts';
  import {listenPeekInput} from '/src/lib/cardPeekSource.ts';
  import {lastPeekInput, peekOpeningFrom} from '/src/lib/cardPeek.ts';
  import '/src/styles/global.css';
  installMotionLevel();
  listenPeekInput();
  const h=React.createElement;
  const SLUGS=['Cards/One','Cards/Two'];
  let sequence=0;
  function Stand(){
    const areaRef=React.useRef(null);
    const [state,setState]=React.useState({block:null,opening:null,exit:'return',place:'one',full:null,handover:null});
    const open=(slug)=>{
      sequence+=1;
      setState((s)=>({...s,block:{slug,id:sequence},opening:{sequence,slug,from:peekOpeningFrom(lastPeekInput(),slug,performance.now()),restored:false},exit:'return'}));
    };
    const close=()=>setState((s)=>({...s,block:null,exit:'return'}));
    window.__switchPlace=()=>setState((s)=>({...s,block:null,exit:'switch',place:s.place==='one'?'two':'one'}));
    window.__hideCards=()=>{for(const card of document.querySelectorAll('[data-feed-card-frame]'))card.style.display='none';};
    // The page's side of the way to the full page and back (App.tsx, О17):
    // the full page laid out unseen until the window hands it over, and
    // shown until the window comes to take it.
    window.__expand=()=>setState((s)=>({...s,full:s.block,block:null,exit:'expand',handover:'toFull'}));
    window.__collapse=()=>setState((s)=>{
      sequence+=1;
      const slug=s.full.slug;
      return {...s,block:s.full,opening:{sequence,slug,from:'full',restored:false},exit:'return',full:null,handover:'toWindow'};
    });
    const handOver=()=>setState((s)=>({...s,handover:null}));
    const content=(block,id)=>h('div',{'data-detail-root':'',id,style:{padding:24,height:'100%',boxSizing:'border-box'}},
      h('button',{id:id?undefined:'close',onClick:close,style:{width:32,height:32}},'×'),
      h('h1',{style:{fontSize:24}},block.slug),
      h('p',null,'The card in its window.'));
    const fullBlock=state.full??(state.handover==='toWindow'?state.block:null);
    return h('div',{style:{display:'flex',height:'100vh',background:'#eef2f7'}},
      h('main',{ref:areaRef,style:{position:'relative',flex:'1',minWidth:0,overflow:'hidden'}},
        fullBlock&&h('div',{'data-full-page':'',style:{position:'absolute',inset:0,zIndex:5,background:'white',visibility:state.handover==='toFull'?'hidden':'visible'}},content(fullBlock,'full-root')),
        h('div',{'data-grid-scroll':'',id:'feed','data-place':state.place,style:{position:'absolute',inset:0}},
          SLUGS.map((slug,index)=>h('div',{key:slug,'data-feed-card-frame':'','data-block-slug':slug,id:'card-'+index,onClick:()=>open(slug),
            style:{position:'absolute',left:80+index*300,top:220,width:240,height:180,borderRadius:4,background:'#c9d6ea',border:'1px solid #9fb1c9'}},slug))),
        h(CardPeek,{block:state.block,opening:state.opening,exit:state.exit,placeReady:true,areaRef,onClose:close,onReopen:(block)=>open(block.slug),onHandOver:handOver},
          (block)=>content(block,undefined))));
  }
  createRoot(document.getElementById('root')).render(h(Stand));
`;

/** Records every frame from now on: the window's place and opacity, the
 *  scrim's opacity, the surface's box, the content's opacity, and whether the
 *  card in the feed shows. Read after the frame is produced, so it is what
 *  the frame showed. Clicks are marked with the time they came. */
function installRecorder() {
  window.__frames = [];
  window.__clicks = [];
  window.__recording = false;
  const read = () => {
    const nudge = document.querySelector("[data-card-peek-nudge]");
    const scrim = document.querySelector("[data-card-peek-scrim]");
    const surface = document.querySelector("[data-card-peek-surface]");
    const content = document.querySelector("[data-card-peek-content]");
    const anchor = document.querySelector("[data-card-peek-window]");
    const card = document.querySelector("#card-0");
    const full = document.querySelector("[data-full-page]");
    const fullRoot = full?.querySelector("[data-detail-root]");
    const boxOf = (element) => {
      const box = element.getBoundingClientRect();
      return { x: box.left, y: box.top, width: box.width, height: box.height };
    };
    const fullPage = full && getComputedStyle(full).visibility !== "hidden" ? boxOf(fullRoot) : null;
    if (!nudge || !scrim || !surface || !anchor) return { present: false, fullPage };
    const weight = (selector) => {
      const element = anchor.querySelector(selector);
      return element ? Number(getComputedStyle(element).opacity) : null;
    };
    const root = document.querySelector("[data-card-peek-content] [data-detail-root]");
    const style = getComputedStyle(nudge);
    const matrix = /^matrix\(([^)]+)\)$/.exec(style.transform);
    const values = matrix ? matrix[1].split(",").map(Number) : [1, 0, 0, 1, 0, 0];
    const box = surface.getBoundingClientRect();
    return {
      present: true,
      scale: values[0],
      scaleY: values[3],
      shear: Math.abs(values[1]) + Math.abs(values[2]),
      y: values[5],
      x: values[4],
      opacity: Number(style.opacity) * Number(getComputedStyle(anchor).opacity),
      scrim: Number(getComputedStyle(scrim).opacity),
      content: content ? Number(getComputedStyle(content).opacity) : 1,
      surface: { x: box.left, y: box.top, width: box.width, height: box.height },
      cardShown: card ? getComputedStyle(card).visibility !== "hidden" && !card.hasAttribute("data-card-peek-hidden") : false,
      preparing: document.querySelector("[data-card-peek-preparing]") !== null,
      // The way to and from the full page (О17): the frame's line, shadow
      // and the window's corner by their shares, the card's box, the full
      // page's box while it shows.
      line: weight('[data-peek-piece="lineTop"]'),
      shadow: weight('[data-peek-piece="shadow"]'),
      corner: weight('[data-peek-piece="cornerTopLeft"] [data-peek-weight="window"]'),
      contentBox: root ? boxOf(root) : null,
      area: boxOf(document.querySelector("main")),
      fullPage,
    };
  };
  // A frame's time on the clock the animations run by, the document
  // timeline's: the motion's own "time gone by" (ОУ4, rule 2). The window's
  // place and opacity, run by the compositor in Minimal, are read in the
  // frame itself; the surface's box, which Full's spring writes in its own
  // frame callback, once the frame's callbacks have all run.
  const loop = () => {
    const frameTime = document.timeline.currentTime;
    if (window.__recording) {
      const record = { at: performance.now(), frameTime, ...read() };
      window.__frames.push(record);
      setTimeout(() => {
        record.painted = { at: record.at, frameTime: record.frameTime, ...read() };
      }, 0);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.addEventListener("click", () => window.__clicks.push(performance.now()), true);
  window.__read = read;
}

/** E at a share of the time, as CSS evaluates cubic-bezier(). */
function ease(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const [x1, y1, x2, y2] = EASE;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  let low = 0;
  let high = 1;
  let u = t;
  for (let index = 0; index < 60; index += 1) {
    const x = ((ax * u + bx) * u + cx) * u;
    if (Math.abs(x - t) < 1e-9) break;
    if (x < t) low = u;
    else high = u;
    u = (low + high) / 2;
  }
  return ((ay * u + by) * u + cy) * u;
}

const share = (frame) => frame.y / MARGIN_PX;
const lineError = (frame) => Math.abs(frame.y / MARGIN_PX - (1 - frame.scale) / (1 - CENTER_SCALE));

function near(actual, expected, message, within) {
  assert(Math.abs(actual - expected) <= within, `${message}: ${actual} against ${expected}`);
}

const passed = (message) => console.log(`PASS: ${message}`);

const vite = await startAuditVite([{
  name: "card-peek-motion-audit",
  resolveId(id) { if (id === entry) return `\0${entry}`; return undefined; },
  load(id) { if (id === `\0${entry}`) return STAND_PAGE; return undefined; },
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (!req.url.startsWith("/__card-peek-motion-audit")) return next();
      res.setHeader("Content-Type", "text/html");
      res.end(await server.transformIndexHtml(req.url, `<html><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`));
      return undefined;
    });
  },
}]);

let browser;
try {
  browser = await webkit.launch({ headless: true });

  /** A fresh stand at `level` (null: no stored level). */
  const fresh = async ({ level, reducedMotion = "no-preference" }) => {
    const page = await browser.newPage({ viewport: VIEWPORT, reducedMotion });
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((stored) => {
      if (stored === null) window.localStorage.removeItem("mine.motion");
      else window.localStorage.setItem("mine.motion", stored);
    }, level);
    await page.addInitScript(installRecorder);
    await page.goto(new URL("/__card-peek-motion-audit", vite.origin).href, { timeout: COLD_START_MS });
    await page.waitForSelector("#card-0", { timeout: COLD_START_MS });
    await page.waitForTimeout(300);
    return { page, errors };
  };

  const record = (page) => page.evaluate(() => {
    window.__frames = [];
    window.__clicks = [];
    window.__recording = true;
  });
  const recorded = async (page) => {
    const frames = await page.evaluate(() => {
      window.__recording = false;
      return window.__frames;
    });
    const clicks = await page.evaluate(() => window.__clicks);
    return { frames, clicks };
  };
  const frames = (page, count) => page.evaluate((wanted) => new Promise((resolve) => {
    let left = wanted;
    const next = () => {
      left -= 1;
      if (left <= 0) setTimeout(resolve, 0);
      else requestAnimationFrame(next);
    };
    requestAnimationFrame(next);
  }), count);
  const level = (page) => page.evaluate(() => document.documentElement.getAttribute("data-motion"));

  /** Opens the first card with a click and lets the window come to rest. */
  const openToRest = async (page) => {
    await page.click("#card-0");
    await page.waitForSelector("[data-card-peek]:not([data-card-peek-preparing])");
    await frames(page, 30);
  };

  /** The frames of a leaving, from the last one before the click to the
   *  last with the window, and the one after. */
  const leaving = ({ frames: all, clicks }) => {
    const click = clicks.at(-1);
    assert(click !== undefined, "a click was heard");
    const before = all.filter((frame) => frame.at < click && frame.present).at(-1);
    const after = all.filter((frame) => frame.at >= click);
    const withWindow = after.filter((frame) => frame.present);
    const gone = after.find((frame, index) => !frame.present && index > 0);
    return { before, after, withWindow, gone };
  };

  /** ОУ4 rules 1–4 on a leaving that began with a press. */
  const checkLeavingLine = (name, run) => {
    const { before, withWindow, gone } = leaving(run);
    assert(before, `${name}: a frame before the press`);
    assert(withWindow.length >= 3, `${name}: the leaving has frames (${withWindow.length})`);
    // Rule 1: every frame on the line, both axes alike.
    for (const frame of [before, ...withWindow]) {
      assert(lineError(frame) <= LINE_TOLERANCE, `${name}: off the line by ${lineError(frame)} at y ${frame.y}, scale ${frame.scale}`);
      near(frame.scale, frame.scaleY, `${name}: one scale on both axes`, 1e-6);
      near(frame.shear, 0, `${name}: no shear`, 1e-6);
    }
    // Rule 2: no jump back, no jump ahead of the curve.
    const first = withWindow[0];
    const start = share(before);
    assert(share(first) >= start - 1e-4, `${name}: the first frame after the press went back from ${start} to ${share(first)}`);
    const elapsed = first.frameTime - before.frameTime;
    const most = start + (1 - start) * ease((elapsed + CLOCK_SLACK_MS) / EXIT_MS);
    assert(share(first) <= most, `${name}: the first frame after the press ${share(first)} ahead of the curve's ${most} after ${elapsed} ms`);
    // Rule 3: down in every frame until the end, faster than before the press.
    for (let index = 1; index < withWindow.length; index += 1) {
      const previous = withWindow[index - 1];
      const frame = withWindow[index];
      if (share(previous) < 1 - 1e-4) assert(share(frame) > share(previous), `${name}: frame ${index} stopped or turned at ${share(frame)}`);
    }
    // Rule 4: the last frame with the window at the end, faded out; then none.
    const last = withWindow.at(-1);
    near(share(last), 1, `${name}: the last frame at 40 px`, 1e-3);
    near(last.scale, CENTER_SCALE, `${name}: the last frame at 95 %`, 1e-4);
    near(last.opacity, 0, `${name}: the last frame faded out`, 1e-3);
    near(last.scrim, 0, `${name}: the scrim faded out`, 1e-3);
    assert(gone, `${name}: the window left the page`);
    return { before, first, last, elapsed };
  };

  // ── НС3: the system's flag with no stored level is Minimal ──
  {
    const { page, errors } = await fresh({ level: null, reducedMotion: "reduce" });
    assert.equal(await level(page), "minimal", "Reduce motion with no stored level");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await frames(page, 2);
    assert.equal(await level(page), "full", "the system's flag followed on the fly");
    await page.close();
    const stored = await fresh({ level: "full", reducedMotion: "reduce" });
    assert.equal(await level(stored.page), "full", "a stored level outranks the system's flag");
    await stored.page.close();
    assert.deepEqual(errors, [], "page errors");
    passed("the system's flag chooses Minimal with no stored level, on the fly; a stored level stays");
  }

  // ── ОУ2: Minimal's rise ──
  {
    const { page, errors } = await fresh({ level: "minimal" });
    assert.equal(await level(page), "minimal", "the stored level");
    await record(page);
    await page.click("#card-0");
    await frames(page, 30);
    const run = await recorded(page);
    // Read once the frame's callbacks ran: the rise starts in one of them.
    const shown = run.frames.map((frame) => frame.painted).filter((frame) => frame?.present && !frame.preparing);
    assert(shown.length > 5, "the window showed");
    const moving = shown.filter((frame) => frame.opacity < 1 - 1e-4 || frame.y > 1e-3);
    const first = shown[0];
    assert(first.y <= MARGIN_PX / 6 + 1e-3 && first.y >= 0, `the rise starts at most 6.67 px low: ${first.y}`);
    assert(first.scale >= CENTER_SCALE - 1e-4, `the rise starts at 95 % or more: ${first.scale}`);
    for (const frame of shown) {
      near(frame.content, 1, "the content shows from the first frame", 1e-4);
      assert(frame.cardShown, "the card in the feed stays in view");
      near(frame.scale, frame.scaleY, "one scale on both axes", 1e-6);
      near(frame.scrim, frame.opacity, "the scrim at the window's opacity", 0.02);
      // On the rise's own line: 6.67 px at 95 % to its place.
      const t = frame.y / (MARGIN_PX / 6);
      near(frame.scale, 1 - (1 - CENTER_SCALE) * t, "the rise's shift and scale together", 0.002);
    }
    for (let index = 1; index < shown.length; index += 1) {
      assert(shown[index].y <= shown[index - 1].y + 1e-4, "it only rises");
      assert(shown[index].opacity >= shown[index - 1].opacity - 1e-4, "it only shows");
    }
    const rest = shown.find((frame) => frame.opacity >= 1 - 1e-4 && frame.y <= 1e-3);
    assert(rest, "it came to rest");
    const took = rest.frameTime - first.frameTime;
    near(took, ENTER_MS, "the rise lasts 150 ms", 2 * (1000 / 60) + 1);
    assert(moving.length >= 4, `the rise has frames of its own (${moving.length})`);
    assert.deepEqual(errors, [], "page errors");
    passed(`Minimal rises from ${first.y.toFixed(2)} px and ${first.scale.toFixed(4)} to its place in ${Math.round(took)} ms, content shown, the card in view`);

    // ── ОУ3: the sink, by its × ──
    await record(page);
    await frames(page, 3);
    await page.click("#close");
    await frames(page, 20);
    const byClose = checkLeavingLine("× at rest", await recorded(page));
    passed(`× sinks from rest to 40 px and 95 % on the line, ${Math.round(byClose.last.frameTime - byClose.before.frameTime)} ms to the last frame, first frame ${share(byClose.first).toFixed(3)} after ${Math.round(byClose.elapsed)} ms`);
    await page.close();
  }

  // ── ОУ3: the sink by a press on the scrim's side, by a change of place, with no card on screen ──
  for (const [name, close] of [
    ["a press on the scrim's side", (page) => page.mouse.click(12, 500)],
    ["a change of collection", (page) => page.evaluate(() => {
      window.__clicks.push(performance.now());
      window.__switchPlace();
    })],
    ["a card gone from the screen", async (page) => {
      await page.evaluate(() => window.__hideCards());
      await page.click("#close");
    }],
  ]) {
    const { page, errors } = await fresh({ level: "minimal" });
    await openToRest(page);
    await record(page);
    await frames(page, 3);
    await close(page);
    await frames(page, 20);
    const run = await recorded(page);
    const { last } = checkLeavingLine(name, run);
    assert(last, name);
    assert.deepEqual(errors, [], `${name}: page errors`);
    passed(`Minimal sinks the same way on ${name}`);
    await page.close();
  }

  // ── ОУ4: the hint's step is the leaving's start ──
  for (const [name, wait] of [
    ["at rest", null],
    ["in the step", "settled"],
    ["midway through the step", 45],
  ]) {
    const { page, errors } = await fresh({ level: "minimal" });
    await openToRest(page);
    await record(page);
    await frames(page, 3);
    // Midway, while the step still grows: the press is sent from the page in
    // the first frame the step has run `wait` ms, watched from before the
    // pointer comes, as a press there would come.
    const pressedMidway = typeof wait === "number" ? page.evaluate((ms) => new Promise((resolve) => {
      const watch = () => {
        const nudge = document.querySelector("[data-card-peek-nudge]");
        const step = nudge?.getAnimations().find((animation) => String(animation.effect?.getKeyframes().at(-1)?.transform ?? "").includes("6.667px"));
        if (typeof step?.currentTime !== "number" || step.currentTime < ms) {
          requestAnimationFrame(watch);
          return;
        }
        setTimeout(() => {
          document.querySelector("[data-card-peek-scrim]").dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 606, clientY: 26, detail: 1 }));
          resolve(step.currentTime);
        }, 2);
      };
      requestAnimationFrame(watch);
    }), wait) : null;
    if (wait !== null) {
      // A slow pointer that comes to rest on the band over the window.
      await page.mouse.move(600, 26);
      for (let step = 0; step < 6; step += 1) {
        await page.mouse.move(600 + step, 26);
        await page.waitForTimeout(16);
      }
      if (wait === "settled") {
        await page.waitForSelector("[data-card-peek-hint][data-shown]");
        await page.waitForTimeout(ENTER_MS + 80);
      }
    }
    if (pressedMidway) await pressedMidway;
    else await page.mouse.click(wait === null ? 600 : 606, 26);
    await frames(page, 20);
    const run = await recorded(page);
    const { before, first, elapsed } = checkLeavingLine(name, run);
    if (wait === "settled") near(share(before), NUDGE_SHARE, "in the step: a sixth of the leaving", 2e-3);
    if (wait === null) near(share(before), 0, "at rest: at its place", 1e-4);
    if (typeof wait === "number") {
      assert(share(before) > 1e-3 && share(before) < NUDGE_SHARE - 1e-3, `midway: between its place and the step (${share(before)})`);
      // The step was still on its way down in the last frame before the press.
      const stepFrames = run.frames.filter((frame) => frame.present && frame.at < run.clicks.at(-1));
      const previous = stepFrames.at(-2);
      const stepSpeed = (share(before) - share(previous)) / (before.frameTime - previous.frameTime);
      const leavingSpeed = (share(first) - share(before)) / (first.frameTime - before.frameTime);
      assert(stepSpeed > 0, "midway: the step was growing");
      assert(leavingSpeed >= stepSpeed, `rule 3: the leaving ${leavingSpeed} slower than the step ${stepSpeed}`);
    }
    // The steps of each frame, for the record.
    const shares = [before, ...leaving(run).withWindow].map((frame) => share(frame).toFixed(3)).join(" → ");
    assert.deepEqual(errors, [], `${name}: page errors`);
    passed(`a press ${name} goes on down the line with no jump (${Math.round(elapsed)} ms frame): ${shares}`);
    await page.close();
  }

  // ── ОУ8: Off, at once both ways ──
  {
    const { page, errors } = await fresh({ level: "off" });
    await record(page);
    await page.click("#card-0");
    await frames(page, 3);
    const opened = await recorded(page);
    const firstAfter = opened.frames.find((frame) => frame.at >= opened.clicks[0]);
    assert(firstAfter?.present, "Off: the window in the first frame after the press");
    near(firstAfter.opacity, 1, "Off: whole at once", 1e-4);
    near(firstAfter.scrim, 1, "Off: the scrim at once", 1e-4);
    near(firstAfter.y, 0, "Off: at its place", 1e-4);
    assert(firstAfter.cardShown, "Off: the card stays in view");
    await record(page);
    await page.click("#close");
    await frames(page, 3);
    const closed = await recorded(page);
    const afterClose = closed.frames.find((frame) => frame.at >= closed.clicks[0]);
    assert(afterClose && !afterClose.present, "Off: no window in the first frame after the press");
    assert.deepEqual(errors, [], "Off: page errors");
    passed("Off stands the window in the press's frame and takes it off in the next press's frame");
    await page.close();
  }

  // ── Full: the growth starts on the card and the closing ends on it ──
  {
    const { page, errors } = await fresh({ level: "full" });
    const card = await page.evaluate(() => {
      const box = document.querySelector("#card-0").getBoundingClientRect();
      return { x: box.left, y: box.top, width: box.width, height: box.height };
    });
    await record(page);
    await page.click("#card-0");
    await frames(page, 40);
    const opened = await recorded(page);
    // Full's spring writes in its own frame callback: read once they ran.
    const moving = opened.frames.map((frame) => frame.painted).filter((frame) => frame?.present && !frame.preparing);
    const first = moving[0];
    for (const side of ["x", "y", "width", "height"]) near(first.surface[side], card[side], `Full: the first frame on the card (${side})`, 1.5);
    assert(!first.cardShown, "Full: the card hidden while the window stands for it (О14)");
    await record(page);
    await page.click("#close");
    await frames(page, 40);
    const closed = await recorded(page);
    const last = closed.frames.filter((frame) => frame.at >= closed.clicks[0]).map((frame) => frame.painted).filter((frame) => frame?.present).at(-1);
    for (const side of ["x", "y", "width", "height"]) near(last.surface[side], card[side], `Full: the last frame on the card (${side})`, 1.5);
    assert.deepEqual(errors, [], "Full: page errors");
    passed("Full grows out of its card and lands back on it as before");
    await page.close();
  }

  // ── О17, ОУ7: the way to the full page and back ──
  /** The right part with the window's line a pixel past each edge: where
   *  the window's frame ends on the way to the full page. */
  const fullRect = (frame) => ({ x: frame.area.x - 1, y: frame.area.y - 1, width: frame.area.width + 2, height: frame.area.height + 2 });
  const boxNear = (actual, expected, message) => {
    assert(actual, `${message}: a box`);
    for (const side of ["x", "y", "width", "height"]) near(actual[side], expected[side], `${message} (${side})`, BOX_SLACK_PX);
  };
  const holds = (outer, inner) => outer.x <= inner.x + BOX_SLACK_PX && outer.y <= inner.y + BOX_SLACK_PX
    && outer.x + outer.width >= inner.x + inner.width - BOX_SLACK_PX && outer.y + outer.height >= inner.y + inner.height - BOX_SLACK_PX;
  /** The window's share, 1 at its place and 0 at the full page, by its width. */
  const windowShare = (frame, place) => {
    const full = fullRect(frame).width;
    return (full - frame.surface.width) / (full - place.width);
  };
  const shownWindow = (frame) => frame.present && !frame.preparing && frame.opacity > 1 - 1e-3;
  /** The frames from the trigger on, read once the frame's callbacks ran. */
  const fromTrigger = (run) => {
    const at = run.clicks.at(-1);
    return run.frames.filter((frame) => frame.at >= at).map((frame) => frame.painted).filter(Boolean);
  };
  const FRAME_MS = 1000 / 60;
  /** How far the way may go in its first frame, as a share: the window's
   *  spring from rest moves 7 % in a frame, the move curve less. The frame's
   *  box is read once the frame's callbacks ran, the first step included. */
  const FIRST_STEP_SHARE = 0.1;
  /** CARD_PEEK_SPRING_MS (cardPeek.ts): the window's spring from rest to rest. */
  const SPRING_MS = 367;
  for (const motionName of ["full", "minimal"]) {
    const { page, errors } = await fresh({ level: motionName });
    await openToRest(page);
    const place = (await page.evaluate(() => window.__read())).surface;

    // Out to the full page.
    await record(page);
    await frames(page, 3);
    await page.evaluate(() => {
      window.__clicks.push(performance.now());
      window.__expand();
    });
    await frames(page, motionName === "full" ? 45 : 25);
    const out = fromTrigger(await recorded(page));
    const outWindow = out.filter((frame) => frame.present);
    assert(outWindow.length >= 4, `${motionName}: the way to the full page has frames (${outWindow.length})`);
    // No jump at the start: the first frame within a frame's step of the
    // window's place, the top edge and the sides alike.
    const firstOut = outWindow[0];
    assert(windowShare(firstOut, place) >= 1 - FIRST_STEP_SHARE, `${motionName}: the first frame ${windowShare(firstOut, place)} of the way from the window's place`);
    assert(holds(firstOut.surface, place), `${motionName}: the first frame holds the window's place`);
    for (const [index, frame] of out.entries()) {
      assert(shownWindow(frame) || frame.fullPage, `${motionName}: frame ${index} shows neither the window nor the full page`);
      if (!frame.present) continue;
      near(frame.opacity, 1, `${motionName}: the window does not fade (frame ${index})`, 1e-3);
      near(frame.y, 0, `${motionName}: the window does not move down (frame ${index})`, 1e-3);
      assert(frame.fullPage === null, `${motionName}: the full page unseen while the window goes (frame ${index})`);
      const p = windowShare(frame, place);
      for (const part of ["scrim", "line", "shadow", "corner"]) near(frame[part], p, `${motionName}: the ${part} by the window's share (frame ${index})`, 0.02);
    }
    for (let index = 1; index < outWindow.length; index += 1) {
      assert(holds(outWindow[index].surface, outWindow[index - 1].surface), `${motionName}: the edges only go out (frame ${index})`);
    }
    const lastOut = outWindow.at(-1);
    boxNear(lastOut.surface, fullRect(lastOut), `${motionName}: the last frame on the right part's edges`);
    boxNear(lastOut.contentBox, lastOut.area, `${motionName}: the card in the last frame where the full page stands`);
    const handed = out[out.indexOf(lastOut) + 1];
    assert(handed && !handed.present && handed.fullPage, `${motionName}: the full page in the frame after the window's last`);
    boxNear(handed.fullPage, lastOut.contentBox, `${motionName}: the full page where the window's last frame held the card`);
    const outMs = lastOut.frameTime - outWindow[0].frameTime;
    if (motionName === "minimal") near(outMs, MOVE_MS, "Minimal: the way to the full page lasts 150 ms", 2 * FRAME_MS + 1);
    else near(outMs, SPRING_MS, "Full: the way to the full page on the window's spring", 3 * FRAME_MS + 1);
    passed(`${motionName}: the window goes to the full page in ${Math.round(outMs)} ms, not fading, not moving down, line, shadow, corner and scrim by its share; its last frame is the full page's first`);

    // Back from the full page to the window.
    await record(page);
    await frames(page, 3);
    await page.evaluate(() => {
      window.__clicks.push(performance.now());
      window.__collapse();
    });
    await frames(page, motionName === "full" ? 45 : 25);
    const back = fromTrigger(await recorded(page));
    const backWindow = back.filter(shownWindow);
    assert(backWindow.length >= 4, `${motionName}: the way back has frames (${backWindow.length})`);
    for (const [index, frame] of back.entries()) {
      assert(shownWindow(frame) || frame.fullPage, `${motionName}: frame ${index} of the way back shows neither`);
      if (shownWindow(frame)) assert(frame.fullPage === null, `${motionName}: the full page gone once the window shows (frame ${index})`);
    }
    const firstBack = backWindow[0];
    assert(windowShare(firstBack, place) <= FIRST_STEP_SHARE, `${motionName}: the first frame back ${windowShare(firstBack, place)} of the way from the full page`);
    assert(holds(fullRect(firstBack), firstBack.surface), `${motionName}: the first frame back within the full page's place`);
    for (let index = 1; index < backWindow.length; index += 1) {
      assert(holds(backWindow[index - 1].surface, backWindow[index].surface), `${motionName}: the edges only come in (frame ${index})`);
      near(backWindow[index].y, 0, `${motionName}: the window does not move down on the way back (frame ${index})`, 1e-3);
    }
    // Landed: the frame the way ends on its place exactly, the spring's
    // settling or the move's end (a spring is within the slack long before).
    const LANDED_PX = 0.05;
    const landed = backWindow.find((frame) => Math.abs(frame.surface.width - place.width) <= LANDED_PX && Math.abs(frame.surface.y - place.y) <= LANDED_PX);
    assert(landed, `${motionName}: the window lands on its place`);
    boxNear(backWindow.at(-1).surface, place, `${motionName}: the window at its place at rest`);
    near(backWindow.at(-1).scrim, 1, `${motionName}: the scrim back`, 1e-3);
    const backMs = landed.frameTime - firstBack.frameTime;
    if (motionName === "minimal") near(backMs, MOVE_MS, "Minimal: the way back lasts 150 ms", 2 * FRAME_MS + 1);
    else near(backMs, SPRING_MS, "Full: the way back on the window's spring", 3 * FRAME_MS + 1);
    assert.deepEqual(errors, [], `${motionName}: page errors`);
    passed(`${motionName}: the full page gives the card back, the window's first frame on the full page's place, at its place in ${Math.round(backMs)} ms`);
    await page.close();
  }
  {
    const { page, errors } = await fresh({ level: "off" });
    await openToRest(page);
    const place = (await page.evaluate(() => window.__read())).surface;
    await record(page);
    await page.evaluate(() => {
      window.__clicks.push(performance.now());
      window.__expand();
    });
    await frames(page, 3);
    const out = fromTrigger(await recorded(page));
    assert(out[0] && !out[0].present && out[0].fullPage, "Off: the full page in the first frame, no window");
    await record(page);
    await page.evaluate(() => {
      window.__clicks.push(performance.now());
      window.__collapse();
    });
    await frames(page, 3);
    const back = fromTrigger(await recorded(page));
    assert(back[0] && shownWindow(back[0]) && back[0].fullPage === null, "Off: the window in the first frame, no full page");
    boxNear(back[0].surface, place, "Off: the window at its place at once");
    assert.deepEqual(errors, [], "Off: page errors");
    passed("Off: the full page and the window each stand in one frame");
    await page.close();
  }

  // ── НС5: the level on the root before the first render of the app's pages ──
  for (const path of ["/", "/settings.html", "/tabbar.html"]) {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page.addInitScript(() => {
      window.localStorage.setItem("mine.motion", "off");
      window.__levelAtFirstRender = undefined;
      const watch = new MutationObserver(() => {
        const root = document.getElementById("root");
        if (root && root.childNodes.length > 0 && window.__levelAtFirstRender === undefined) {
          window.__levelAtFirstRender = document.documentElement.getAttribute("data-motion");
          watch.disconnect();
        }
      });
      watch.observe(document, { childList: true, subtree: true });
    });
    await page.goto(new URL(path, vite.origin).href, { timeout: COLD_START_MS });
    await page.waitForFunction(() => window.__levelAtFirstRender !== undefined, null, { timeout: COLD_START_MS });
    assert.equal(await page.evaluate(() => window.__levelAtFirstRender), "off", `${path}: the level on the root at the first render`);
    passed(`${path}: the stored level stands on the root before the first render`);
    await page.close();
  }
} finally {
  await browser?.close();
  await vite.close();
}
