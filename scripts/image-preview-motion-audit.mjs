// The image preview's motion in headless WebKit, the engine of Mine's window
// (SPEC_MEDIA_ASSET_ACTIONS.md, «Движение просмотра изображения»): real layout,
// real decoding, real pixels, which the jsdom tests cannot see. A stand page
// holds sources of every kind; a second page opens the real `Detail`. Frames
// are stepped by hand, so each one is measured and photographed at 60 Hz; one
// run goes on the real clock for the frame times. With IMAGE_PREVIEW_STRIP_DIR
// set it writes contact sheets of the opening and the closing there.
// Starts and stops its own Vite.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { webkit } from "playwright";
import { PNG } from "pngjs";
import { COLD_START_MS, startAuditVite } from "./audit-vite.mjs";

const FRAME_MS = 1000 / 60;
const VIEWPORT = { width: 1200, height: 760 };
/** The picture's own size: larger than the preview's limits on either axis. */
const PICTURE = { width: 1600, height: 1200 };
/** The colour at the picture's centre, unique on the stand. */
const DISC = [214, 0, 142];
const STRIP_DIR = process.env.IMAGE_PREVIEW_STRIP_DIR ?? null;

const entry = "/image-preview-audit-entry.js";

const STAND_PAGE = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {ImagePreviewOverlay} from '/src/components/ImagePreviewOverlay.tsx';
  import {Detail} from '/src/components/Detail.tsx';
  import {DndContext,PointerSensor,useSensor,useSensors} from '@dnd-kit/core';
  import {TooltipProvider} from '/src/components/ui/tooltip.tsx';
  import {installMotionLevel} from '/src/lib/motion.ts';
  import '/src/styles/global.css';
  // The level as an app page takes it: the stored one, else the system's.
  installMotionLevel();
  const h=React.createElement;
  const media=name=>location.origin+'/audit-media/'+name;
  window.__TAURI_INTERNALS__={convertFileSrc:path=>media(path.split('/').pop().split('?')[0]),invoke:async command=>{if(command==='get_block')return null;throw Error(command);}};
  const fill={position:'absolute',inset:0,width:'100%',height:'100%',display:'block'};
  function Stand(){
    const [preview,setPreview]=React.useState(null);
    const open=(event,src=media('photo.png'))=>setPreview({src,mediaRef:'photo.png',source:event.currentTarget.closest('[data-source]'),openedBy:event.detail===0?'keyboard':'pointer'});
    const frame=(id,style,fit,children)=>h('div',{'data-source':id,id,onClick:open,style:{position:'absolute',overflow:'hidden',...style}},h('img',{src:media('photo.png'),alt:'',draggable:false,style:{...fill,objectFit:fit}}),children);
    return h('div',{id:'page',style:{position:'fixed',inset:0,background:'repeating-linear-gradient(45deg,#dfe7f2 0 40px,#c9d6ea 40px 80px)'}},
      frame('contain',{left:40,top:60,width:320,height:240,background:'#fff'},'contain',
        h('button',{id:'keyboard',style:{position:'absolute',right:8,top:8,width:32,height:32},onClick:event=>{event.stopPropagation();open(event);}},'E')),
      frame('cover',{left:420,top:60,width:240,height:240,borderRadius:16},'cover'),
      h('div',{id:'scroller',style:{position:'absolute',left:720,top:60,width:300,height:160,overflow:'auto'}},
        h('div',{style:{position:'relative',height:600}},frame('clipped',{left:10,top:60,width:280,height:210},'cover'))),
      h('div',{'data-source':'slow',id:'slow',onClick:event=>open(event,media('slow.png')),style:{position:'absolute',left:40,top:400,width:320,height:240,overflow:'hidden'}},
        h('img',{'data-detail-preview-backing':'',src:media('thumb.png'),alt:'',style:{...fill,objectFit:'contain'}}),
        h('img',{src:media('slow.png'),alt:'',style:{...fill,objectFit:'contain',opacity:0}})),
      h('button',{id:'no-source',style:{position:'absolute',left:420,top:400,width:120,height:32},onClick:()=>setPreview({src:media('photo.png'),mediaRef:'photo.png',openedBy:'pointer'})},'No source'),
      h(ImagePreviewOverlay,{preview,onClose:()=>setPreview(null)}));
  }
  function DetailPage(){
    const [preview,setPreview]=React.useState(null);
    const base={id:1,slug:'card',card_kind:'media',block_type:'image',title:'Card',display_title:'Card',fallback_label:'Card',description:null,url:null,media_file:'Media/photo.png',thumbnail:null,saved_at:'2026-09-19T00:00:00Z',source:null,width:${PICTURE.width},height:${PICTURE.height},author:null,body:'',preview_text:null,first_image:null,media_urls:null,media_dimensions:null,preview_manifest:null,feed_playback:null,thumb_format:null,thumb_mtime:0,related_notes:[],tags:[]};
    const noop=()=>{};
    // The app's press: 8 px of travel make it a drag, less stays a click.
    const sensors=useSensors(useSensor(PointerSensor,{activationConstraint:{distance:8}}));
    return h(TooltipProvider,null,h(DndContext,{sensors},
      h('div',{style:{display:'flex',height:'100vh'}},h('main',{style:{position:'relative',flex:'1',minWidth:0}},
        h(Detail,{block:base,vaultPath:'/vault',thumbsRootPath:'/thumbs',tags:[],onClose:noop,onToggleTag:noop,onCreateAndAssign:noop,onRequestRename:noop,onRequestDelete:noop,onOpenImagePreview:setPreview}))),
      h(ImagePreviewOverlay,{preview,onClose:()=>setPreview(null)})));
  }
  const page=new URLSearchParams(location.search).get('page');
  createRoot(document.getElementById('root')).render(h(page==='detail'?DetailPage:Stand));
`;

/** Hand stepping of the page's frames: `requestAnimationFrame` and the clock
 *  stand still until `__frames.step()`; the display goes on painting. */
function installFrames() {
  const raf = window.requestAnimationFrame.bind(window);
  const caf = window.cancelAnimationFrame.bind(window);
  const now = performance.now.bind(performance);
  let held = false;
  let virtual = 0;
  let queue = new Map();
  let id = 1;
  window.__frames = {
    hold() { held = true; virtual = now(); },
    step(ms) {
      virtual += ms;
      const due = [...queue.values()];
      queue = new Map();
      for (const callback of due) callback(virtual);
      return due.length;
    },
    pending: () => queue.size,
  };
  window.requestAnimationFrame = (callback) => {
    if (!held) return raf(callback);
    id += 1;
    queue.set(id, callback);
    return id;
  };
  window.cancelAnimationFrame = (handle) => {
    if (held) queue.delete(handle);
    else caf(handle);
  };
  performance.now = () => (held ? virtual : now());
  // Layout reads of the moving picture and its source, for "read once".
  window.__layoutReads = 0;
  const read = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    window.__layoutReads += 1;
    return read.call(this);
  };
  window.__rect = (element) => {
    const reads = window.__layoutReads;
    const box = read.call(element);
    window.__layoutReads = reads;
    return { x: box.left, y: box.top, width: box.width, height: box.height };
  };
}

/** What the preview shows now. */
function readState() {
  const overlay = document.querySelector("[data-image-preview-overlay]");
  if (!overlay) return null;
  const image = overlay.querySelector("[data-image-preview-image]");
  const style = image && getComputedStyle(image);
  const matrix = style && /^matrix\(([^)]+)\)$/.exec(style.transform);
  return {
    closing: overlay.classList.contains("pointer-events-none"),
    rect: image && window.__rect(image),
    matrix: matrix ? matrix[1].split(",").map(Number) : null,
    clipPath: image?.style.clipPath ?? "",
    visibility: image?.style.visibility ?? "",
    opacity: style ? Number(style.opacity) : 1,
    willChange: image?.style.willChange ?? "",
    backing: image?.style.backgroundImage ?? "",
    natural: image?.naturalWidth ?? 0,
    scrim: Number(getComputedStyle(overlay.querySelector("[data-image-preview-scrim]")).opacity),
    toolbar: Number(getComputedStyle(overlay.querySelector("[data-image-preview-controls]")).opacity),
    stage: overlay.querySelector("[data-image-preview-stage]").className,
    label: overlay.querySelector("[data-image-preview-zoom-label]")?.textContent ?? "",
    scale: Number(image?.getAttribute("data-detail-image-preview-scale") ?? 1),
    laid: image ? { width: image.offsetWidth, height: image.offsetHeight } : null,
  };
}

/** What it shows now, no frame run. */
const state = (page) => page.evaluate(readState);

/** One frame run, then what it shows. */
async function step(page, ms = FRAME_MS) {
  await page.evaluate((delta) => window.__frames.step(delta), ms);
  return state(page);
}

const hold = (page) => page.evaluate(() => window.__frames.hold());

/** The frames of the opening before its first one: at most the wait for the
 *  original, which a real decode ends by itself. */
async function untilStarted(page) {
  for (let index = 0; index < 12; index += 1) {
    const now = await step(page);
    if (now.visibility !== "hidden") return now;
    await page.waitForTimeout(15);
  }
  throw new Error("The motion did not start");
}

const sourceRect = (page, selector) => page.evaluate((target) => window.__rect(document.querySelector(target)), selector);

function near(actual, expected, message, within = 0.75) {
  assert(Math.abs(actual - expected) <= within, `${message}: ${actual} against ${expected}`);
}

function nearRect(actual, expected, message, within = 0.75) {
  for (const side of ["x", "y", "width", "height"]) near(actual[side], expected[side], `${message} (${side})`, within);
}

/** Pixels of two screenshots apart by more than `threshold` on any channel. */
function differing(first, second, threshold = 32) {
  const a = PNG.sync.read(first);
  const b = PNG.sync.read(second);
  let count = 0;
  for (let index = 0; index < a.data.length; index += 4) {
    if (Math.max(
      Math.abs(a.data[index] - b.data[index]),
      Math.abs(a.data[index + 1] - b.data[index + 1]),
      Math.abs(a.data[index + 2] - b.data[index + 2]),
    ) > threshold) count += 1;
  }
  return count;
}

function pixelAt(shot, x, y) {
  const png = PNG.sync.read(shot);
  const offset = (Math.round(y) * png.width + Math.round(x)) * 4;
  return [png.data[offset], png.data[offset + 1], png.data[offset + 2]];
}

function isDisc(colour) {
  return colour.every((channel, index) => Math.abs(channel - DISC[index]) <= 40);
}

/** A picture of `width × height`: lines every twelfth of its width on a soft
 *  gradient, a round disc at the centre. A stretch bends the disc and breaks
 *  the squares; an empty frame has no disc. */
function pictureFile(width, height) {
  const png = new PNG({ width, height });
  const cell = width / 12;
  const radius = height / 8;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const inDisc = Math.hypot(x - width / 2, y - height / 2) <= radius;
      const onLine = x % cell < Math.max(1, width / 400) || y % cell < Math.max(1, width / 400);
      const edge = x < width / 80 || y < width / 80 || x >= width - width / 80 || y >= height - width / 80;
      const colour = inDisc ? DISC
        : edge ? [20, 110, 60]
          : onLine ? [250, 250, 250]
            : [40 + (180 * x) / width, 90 + (100 * y) / height, 170];
      png.data[offset] = colour[0];
      png.data[offset + 1] = colour[1];
      png.data[offset + 2] = colour[2];
      png.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(png, { deflateLevel: 1 });
}

/** A contact sheet of labelled frames, written by the browser itself. */
async function writeStrip(browser, name, cells) {
  if (!STRIP_DIR) return;
  mkdirSync(STRIP_DIR, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1640, height: 1000 } });
  const html = cells.map(({ label, shot }) => `<figure><img src="data:image/png;base64,${shot.toString("base64")}"><figcaption>${label}</figcaption></figure>`).join("");
  await page.setContent(`<!doctype html><style>
    body{margin:8px;background:#111;color:#eee;font:12px/1.2 -apple-system,sans-serif;display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
    figure{margin:0}img{width:100%;display:block;border:1px solid #444}figcaption{padding:2px 0}
  </style>${html}`);
  await page.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0));
  const path = join(STRIP_DIR, name);
  writeFileSync(path, await page.screenshot({ fullPage: true }));
  await page.close();
  console.log(`STRIP: ${path}`);
}

const photo = pictureFile(PICTURE.width, PICTURE.height);
const thumb = pictureFile(160, 120);

const vite = await startAuditVite([{
  name: "image-preview-motion-audit",
  resolveId(id) { if (id === entry) return `\0${entry}`; return undefined; },
  load(id) { if (id === `\0${entry}`) return STAND_PAGE; return undefined; },
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (!req.url.startsWith("/__image-preview-audit")) return next();
      res.setHeader("Content-Type", "text/html");
      res.end(await server.transformIndexHtml(req.url, `<html><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`));
      return undefined;
    });
  },
}]);

let browser;
const passed = (message) => console.log(`PASS: ${message}`);
try {
  browser = await webkit.launch({ headless: true });

  /** A fresh page at the motion level `level` (SPEC_MOTION_LEVELS.md; null:
   *  none stored). `slow` holds the slow original back until it is released. */
  const fresh = async ({ page: pageName = "stand", reducedMotion = "no-preference", level = "full" } = {}) => {
    const page = await browser.newPage({ viewport: VIEWPORT, reducedMotion });
    await page.addInitScript((stored) => {
      if (stored === null) window.localStorage.removeItem("mine.motion");
      else window.localStorage.setItem("mine.motion", stored);
    }, level);
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let release = () => undefined;
    const gate = new Promise((resolve) => { release = resolve; });
    await page.route("**/audit-media/*", async (route) => {
      const name = route.request().url().split("/").pop();
      if (name.startsWith("slow")) await gate;
      await route.fulfill({ contentType: "image/png", body: name.startsWith("thumb") ? thumb : photo });
    });
    await page.addInitScript(installFrames);
    await page.goto(new URL(`/__image-preview-audit?page=${pageName}`, vite.origin).href, { timeout: COLD_START_MS });
    await page.waitForFunction(() => [...document.images].some((image) => image.naturalWidth > 0), null, { timeout: COLD_START_MS });
    await page.waitForTimeout(300);
    return { page, errors, release };
  };

  const clickSource = (page, selector) => page.locator(selector).click({ position: { x: 60, y: 60 } });
  const clickBackground = (page) => page.mouse.click(8, 8);
  const openToRest = async (page, selector) => {
    await clickSource(page, selector);
    await untilStarted(page);
    for (let index = 0; index < 30; index += 1) await step(page);
  };

  // ── The opening, frame by frame, out of a source that crops the picture ──
  {
    const { page, errors } = await fresh();
    const before = await page.screenshot();
    await hold(page);
    const source = await sourceRect(page, "#cover");
    await clickSource(page, "#cover");
    const cells = [{ label: "before the press", shot: before }];

    // Nothing on the page changes before the first frame, the source included:
    // no decoding is asked of an address the page draws (WebKit blanks it).
    near(differing(before, await page.screenshot()), 0, "the page before the first frame", 20);
    const first = await untilStarted(page);
    const firstShot = await page.screenshot();
    cells.push({ label: "frame 1, 0 ms", shot: firstShot });

    // The first frame: the source's own rectangle, crop and corner.
    assert.deepEqual(first.matrix.slice(1, 3), [0, 0], "no shear");
    near(first.matrix[0], first.matrix[3], "first frame: one scale on both axes", 1e-5);
    const scale = first.matrix[0];
    const whole = (source.height * PICTURE.width) / PICTURE.height;
    nearRect(first.rect, { x: source.x + (source.width - whole) / 2, y: source.y, width: whole, height: source.height }, "first frame: the whole picture covers the source");
    const inset = /inset\(([\d.]+)px ([\d.]+)px ([\d.]+)px ([\d.]+)px round ([\d.]+)px\)/.exec(first.clipPath);
    near(Number(inset[4]) * scale, (whole - source.width) / 2, "first frame: the crop");
    near(Number(inset[5]) * scale, 16, "first frame: the source's corner");
    near(first.scrim, 0, "first frame: no blur yet", 1e-3);
    near(first.toolbar, 0, "first frame: no toolbar yet", 1e-3);
    const changed = differing(before, firstShot);
    assert(changed < source.width * source.height * 0.02, `first frame differs from the page in ${changed} pixels`);
    passed(`first frame stands on the source: ${changed} of ${source.width * source.height} pixels differ visibly`);

    const reads = await page.evaluate(() => window.__layoutReads);
    let previous = first;
    let elapsed = 0;
    const trail = [first];
    let settledAt = null;
    for (let index = 1; index < 30; index += 1) {
      const now = await step(page);
      elapsed += FRAME_MS;
      if (now.clipPath === "") break;
      trail.push(now);
      // Nothing stretched: one scale for both axes in every frame.
      assert.deepEqual(now.matrix.slice(1, 3), [0, 0], `frame ${index}: no shear`);
      near(now.matrix[0], now.matrix[3], `frame ${index}: one scale`, 1e-5);
      near(now.rect.width / now.rect.height, PICTURE.width / PICTURE.height, `frame ${index}: the picture's proportion`, 0.01);
      // No overshoot and no way back.
      assert(now.rect.width >= previous.rect.width - 1e-3, `frame ${index}: it grows`);
      const shot = await page.screenshot();
      // Never an empty box: the picture's centre shows in every frame.
      const colour = pixelAt(shot, now.rect.x + now.rect.width / 2, now.rect.y + now.rect.height / 2);
      assert(isDisc(colour), `frame ${index}: the picture is not drawn at its centre: ${colour}`);
      if (index <= 8 || index % 2 === 0) cells.push({ label: `frame ${index + 1}, ${Math.round(elapsed)} ms`, shot });
      if (now.scrim === 1 && settledAt === null) settledAt = elapsed;
      if (elapsed < 183) near(now.toolbar, 0, `${Math.round(elapsed)} ms: no toolbar in the first half`, 1e-3);
      previous = now;
    }
    near(settledAt, 367, "the spring stops at 367 ms", 2 * FRAME_MS);
    assert.equal(await page.evaluate(() => window.__layoutReads), reads, "the motion reads no layout in its frames");
    assert(trail.some((frame) => frame.toolbar > 0 && frame.toolbar < 1), "the toolbar fades in, not at once");
    passed(`the opening stops at ${Math.round(settledAt)} ms, ${trail.length} frames, no overshoot, one scale, no empty frame, no layout read`);

    // The handover to rest, the frame by frame change of styles and layers.
    const atRest = await state(page);
    assert.equal(atRest.clipPath, "", "at rest: no clip");
    near(atRest.scrim, 1, "at rest: the whole blur", 1e-3);
    near(atRest.toolbar, 1, "at rest: the toolbar", 1e-3);
    const restShot = await page.screenshot();
    await step(page);
    const noLayer = await state(page);
    assert.equal(noLayer.willChange, "", "at rest: no layer kept");
    assert.equal(noLayer.matrix, null, "at rest at 100 %: no transform");
    const noLayerShot = await page.screenshot();
    near(differing(restShot, noLayerShot), 0, "no change when the layer goes", 200);
    cells.push({ label: "at rest", shot: restShot }, { label: "at rest, layer gone", shot: noLayerShot });
    await page.waitForTimeout(100);
    near(differing(noLayerShot, await page.screenshot()), 0, "the rest stays", 200);
    passed("the handover to rest changes nothing on screen and keeps no layer");
    await writeStrip(browser, "open-strip.png", cells);

    // ── The closing, the same way back ──
    const closeCells = [{ label: "at rest", shot: noLayerShot }];
    await clickBackground(page);
    let down = await state(page);
    assert(down.closing, "the closing has begun");
    near(down.rect.width, noLayer.rect.width, "the closing's first frame is where it stood");
    let way = 0;
    const closingReads = await page.evaluate(() => window.__layoutReads);
    let lastClosing = down;
    for (let index = 0; index < 30; index += 1) {
      down = await step(page);
      way += FRAME_MS;
      if (!down) break;
      if (way > 125) near(down.toolbar, 0, `${Math.round(way)} ms: the toolbar is gone by the first third`, 1e-3);
      const visible = await page.evaluate(() => document.querySelector("#cover").style.visibility);
      const shot = await page.screenshot();
      if (index < 6 || index % 3 === 0 || visible === "") closeCells.push({ label: `closing ${Math.round(way)} ms${visible === "" ? ", source shown" : ""}`, shot });
      if (visible === "") {
        // The picture lies on the source that shows under it.
        near(down.scrim, 0, "last frame: no blur", 1e-3);
        const lastChanged = differing(before, shot);
        assert(lastChanged < source.width * source.height * 0.02, `last frame differs from the page in ${lastChanged} pixels`);
        passed(`last frame of the closing coincides with the source: ${lastChanged} pixels differ visibly`);
      }
      lastClosing = down;
    }
    assert.equal(down, null, "the overlay has left the page");
    assert(lastClosing.rect.width < source.width * 1.4, "it landed on the source");
    assert.equal(await page.evaluate(() => window.__layoutReads), closingReads, "the closing reads no layout in its frames");
    const after = await page.screenshot();
    closeCells.push({ label: "after", shot: after });
    near(differing(before, after), 0, "the page is back", 80);
    await writeStrip(browser, "close-strip.png", closeCells);
    passed("the closing goes back to the source, the page as it was");
    assert.deepEqual(errors, [], "page errors");
    await page.close();
  }

  // ── A source the scroller cuts: the first frame cut the same ──
  {
    const { page } = await fresh();
    const before = await page.screenshot();
    await hold(page);
    await page.locator("#clipped").click({ position: { x: 60, y: 30 } });
    const first = await untilStarted(page);
    const shot = await page.screenshot();
    const changed = differing(before, shot);
    assert(changed < 300 * 160 * 0.02, `a source cut by its scroller: the first frame differs in ${changed} pixels`);
    assert(first.clipPath.includes("inset("), "the first frame is clipped");
    passed(`a source cut by its scroller: the first frame is cut the same (${changed} pixels)`);
    await page.close();
  }

  // ── Interruption: the turn keeps position and speed ──
  {
    const { page } = await fresh();
    await hold(page);
    await clickSource(page, "#contain");
    let last = await untilStarted(page);
    const widths = [last.rect.width];
    for (let index = 0; index < 3; index += 1) {
      last = await step(page);
      widths.push(last.rect.width);
    }
    const speed = widths[3] - widths[2];
    await clickBackground(page);
    const turned = await state(page);
    near(turned.rect.width, widths[3], "the press moves nothing", 1e-3);
    assert(turned.closing, "the press turns it");
    const back = [turned.rect.width];
    for (let index = 0; index < 8; index += 1) {
      const now = await step(page);
      back.push(now.rect.width);
    }
    assert(back[1] - back[0] > 0 && back[1] - back[0] < speed, `it brakes with its speed: ${back[1] - back[0]} after ${speed}`);
    for (let index = 1; index < back.length - 1; index += 1) {
      const change = (back[index + 1] - back[index]) - (back[index] - back[index - 1]);
      assert(Math.abs(change) < speed, `no break in speed: ${change}`);
    }
    for (let index = 0; index < 30; index += 1) await step(page);
    assert.equal(await state(page), null, "it closed");
    passed("a closing during the opening turns from where it stands, its speed carried through");
    await page.close();
  }

  // ── Zoomed and panned: the closing starts from there; the source moved ──
  {
    const { page } = await fresh();
    await hold(page);
    await openToRest(page, "#contain");
    await page.locator("[data-image-preview-zoom-in]").click();
    await step(page);
    await page.waitForTimeout(250);
    const box = (await state(page)).rect;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30);
    await page.mouse.up();
    await step(page);
    const zoomed = await state(page);
    near(zoomed.scale, 1.2, "zoomed");
    // The source moved while the preview stood.
    await page.evaluate(() => { document.querySelector("#contain").style.left = "120px"; });
    const source = await sourceRect(page, "#contain");
    await page.locator("[data-image-preview-collapse]").click();
    const start = await state(page);
    nearRect(start.rect, zoomed.rect, "the closing starts from the zoom and the pan");
    let last = start;
    for (let index = 0; index < 22; index += 1) last = await step(page);
    nearRect(last.rect, source, "it lands where the source stands at the closing");
    passed("a zoomed and panned preview closes from there, to where the source stands now");
    await page.close();
  }

  // ── The source left the screen: it leaves as a dialog ──
  {
    const { page } = await fresh();
    await hold(page);
    await page.locator("#clipped").click({ position: { x: 60, y: 30 } });
    await untilStarted(page);
    for (let index = 0; index < 30; index += 1) await step(page);
    await page.evaluate(() => { document.querySelector("#scroller").scrollTop = 400; });
    await clickBackground(page);
    const leaving = await state(page);
    for (const name of ["animate-out", "fade-out-0", "zoom-out-95", "duration-200"]) {
      assert(leaving.stage.includes(name), `leaves as a dialog: ${name}`);
    }
    await page.waitForFunction(() => document.querySelector("[data-image-preview-overlay]") === null, null, { polling: 50 });
    assert.equal(await page.evaluate(() => document.querySelector("#clipped").style.visibility), "", "the source shows again");
    passed("with its source off screen it leaves as a dialog");
    await page.close();
  }

  // ── Keyboard: at once; Escape: at once ──
  {
    const { page } = await fresh();
    await hold(page);
    await page.locator("#keyboard").focus();
    await page.keyboard.press("Enter");
    const opened = await state(page);
    assert.equal(opened.clipPath, "", "a key opens with no flight");
    near(opened.scrim, 1, "a key opens with the whole blur", 1e-3);
    near(opened.toolbar, 1, "a key opens with the toolbar", 1e-3);
    assert.equal(await page.evaluate(() => window.__frames.pending()), 1, "only the rest's own frame is asked for");
    await page.keyboard.press("Escape");
    assert.equal(await state(page), null, "Escape closes in its frame");
    passed("a key opens in its frame and Escape closes in its frame");
    await page.close();
  }

  // ── Escape mid-way ──
  {
    const { page } = await fresh();
    await hold(page);
    await clickSource(page, "#contain");
    await untilStarted(page);
    for (let index = 0; index < 5; index += 1) await step(page);
    await page.keyboard.press("Escape");
    assert.equal(await state(page), null, "Escape closes mid-way, at once");
    assert.equal(await page.evaluate(() => document.querySelector("#contain").style.visibility), "", "the source shows again");
    passed("Escape during the motion closes at once");
    await page.close();
  }

  // ── Off: at once, with no wait for the original (SPEC_MOTION_LEVELS.md, ОУ9) ──
  {
    const { page } = await fresh({ level: "off" });
    await hold(page);
    await clickSource(page, "#contain");
    const opened = await state(page);
    assert(opened, "Off: open in the press's frame");
    assert.equal(opened.clipPath, "", "Off: no flight");
    assert.equal(opened.visibility, "", "Off: the picture shown at once");
    near(opened.scrim, 1, "Off: the whole blur at once", 1e-3);
    near(opened.toolbar, 1, "Off: the toolbar at once", 1e-3);
    assert.equal(await page.evaluate(() => document.querySelector("#contain").style.visibility), "", "Off: the source stays");
    await clickBackground(page);
    assert.equal(await state(page), null, "Off: gone in the press's frame");
    passed("at Off the preview opens and leaves at once, with no wait and no flight");
    await page.close();
  }

  // ── The system's flag with no stored level: Minimal's rise (НС3, ОУ9) ──
  {
    const { page } = await fresh({ level: null, reducedMotion: "reduce" });
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-motion")), "minimal", "Reduce motion chooses Minimal");
    await clickSource(page, "#contain");
    // The stage and the island rise on the compositor, the picture with no
    // flight of its own and the source left on the page.
    await page.waitForFunction(() => document.querySelector("[data-image-preview-stage]")?.getAnimations().length > 0);
    const rise = await page.evaluate(() => {
      const [animation] = document.querySelector("[data-image-preview-stage]").getAnimations();
      const frames = animation.effect.getKeyframes();
      return {
        duration: animation.effect.getTiming().duration,
        from: frames[0].transform,
        to: frames.at(-1).transform,
        controls: document.querySelector("[data-image-preview-controls]").getAnimations().length,
        source: document.querySelector("#contain").style.visibility,
        clip: document.querySelector("[data-image-preview-image]").style.clipPath,
      };
    });
    assert.equal(rise.duration, 150, "Minimal: the rise lasts 150 ms");
    assert.equal(rise.from, "translateY(6.667px) scale(0.95)", "Minimal: the rise starts 6.67 px low at 95 %");
    assert.equal(rise.to, "translateY(0px) scale(1)", "Minimal: the rise ends at its place");
    assert.equal(rise.controls, 1, "Minimal: the island rises with the stage");
    assert.equal(rise.source, "", "Minimal: the source stays on the page");
    assert.equal(rise.clip, "", "Minimal: no flight");
    await page.waitForTimeout(300);
    await clickBackground(page);
    const sink = await page.evaluate(() => {
      const [animation] = document.querySelector("[data-image-preview-stage]").getAnimations();
      const frames = animation.effect.getKeyframes();
      return { duration: animation.effect.getTiming().duration, to: frames.at(-1).transform, opacity: frames.at(-1).opacity };
    });
    assert.equal(sink.duration, 100, "Minimal: the leaving lasts 100 ms");
    assert.equal(sink.to, "translateY(40px) scale(0.95)", "Minimal: the leaving ends 40 px down at 95 %");
    assert.equal(Number(sink.opacity), 0, "Minimal: the leaving fades out");
    await page.waitForFunction(() => !document.querySelector("[data-image-preview-overlay]"));
    passed("with Reduce motion and no stored level the preview rises in 150 ms and sinks in 100 ms (Minimal)");
    await page.close();
  }

  // ── No source: a dialog's entrance ──
  {
    const { page } = await fresh();
    await hold(page);
    await page.locator("#no-source").click();
    const opened = await state(page);
    for (const name of ["animate-in", "fade-in-0", "zoom-in-95", "duration-200"]) {
      assert(opened.stage.includes(name), `opens as a dialog: ${name}`);
    }
    assert.equal(opened.clipPath, "", "no flight without a source");
    passed("without a source it opens as a dialog");
    await page.close();
  }

  // ── Input during the motion ──
  {
    const { page } = await fresh();
    await hold(page);
    await clickSource(page, "#contain");
    await untilStarted(page);
    for (let index = 0; index < 4; index += 1) await step(page);
    await page.locator("[data-image-preview-zoom-in]").click();
    await step(page);
    await page.waitForTimeout(30);
    let now = await state(page);
    near(now.scale, 1.2, "the zoom button works during the opening");
    assert.equal(now.label, "120%", "and shows its value");
    await page.mouse.move(600, 340);
    await page.mouse.wheel(0, -60);
    await page.waitForTimeout(50);
    now = await step(page);
    assert(now.scale > 1.2, "the wheel works during the opening");
    for (let index = 0; index < 30; index += 1) now = await step(page);
    assert.equal(now.clipPath, "", "it landed");
    near(now.rect.width, now.laid.width * now.scale, "on what the input asked for", 1.5);
    const landed = now.rect;

    await clickBackground(page);
    for (let index = 0; index < 5; index += 1) now = await step(page);
    assert(now.closing && now.rect.width < landed.width, "it closes");
    await page.locator("[data-image-preview-zoom-in]").click();
    now = await state(page);
    assert(!now.closing, "the zoom button takes the closing over");
    const scale = now.scale;
    for (let index = 0; index < 30; index += 1) now = await step(page);
    assert.equal(now.clipPath, "", "it stayed open");
    assert(now.scale > scale, "and zoomed");
    near(now.scrim, 1, "with the whole blur", 1e-3);
    passed("zoom and the buttons work during the motion and take it over");
    await page.close();
  }

  // ── An original still loading: it starts from what the source draws ──
  {
    const { page, release } = await fresh();
    await hold(page);
    const beforeSlow = await page.screenshot();
    await page.locator("#slow").click({ position: { x: 60, y: 60 } });
    let now = await state(page);
    assert.equal(now.visibility, "hidden", "it waits for the original");
    near(differing(beforeSlow, await page.screenshot()), 0, "the page while it waits", 20);
    for (let index = 0; index < 5; index += 1) {
      now = await step(page);
      await page.waitForTimeout(5);
    }
    assert.equal(now.visibility, "hidden", "before 100 ms it still waits");
    for (let index = 0; index < 2; index += 1) now = await step(page);
    assert.notEqual(now.visibility, "hidden", "past 100 ms it starts");
    assert.equal(now.natural, 0, "the original is not there yet");
    assert(now.backing.includes("thumb.png"), `the thumbnail stands behind it: ${now.backing}`);
    for (let index = 0; index < 6; index += 1) {
      now = await step(page);
      const shot = await page.screenshot();
      const colour = pixelAt(shot, now.rect.x + now.rect.width / 2, now.rect.y + now.rect.height / 2);
      assert(isDisc(colour), `no empty frame while the original loads: ${colour}`);
    }
    for (let index = 0; index < 30; index += 1) now = await step(page);
    const held = now.rect;
    release();
    await page.waitForFunction(() => document.querySelector("[data-image-preview-image]").naturalWidth > 0, null, { polling: 50 });
    await page.waitForTimeout(150);
    now = await state(page);
    assert.equal(now.backing, "", "the backing goes once the original is decoded");
    nearRect(now.rect, held, "the original lands in the place held for it", 1);
    passed("an original still loading: the motion starts from the thumbnail and the original lands in place");
    await page.close();
  }

  // ── The real caller: Detail's media frame ──
  {
    const { page } = await fresh({ page: "detail" });
    const frameSelector = "[data-detail-media-action-frame]";
    await page.locator(`${frameSelector} img`).last().waitFor();
    await page.waitForFunction((selector) => document.querySelector(`${selector} img`).naturalWidth > 0, frameSelector);
    await page.waitForTimeout(200);
    const before = await page.screenshot();
    await hold(page);
    const source = await sourceRect(page, frameSelector);
    await page.locator(frameSelector).click();
    const first = await untilStarted(page);
    nearRect(first.rect, source, "Detail: the first frame stands on the media frame");
    // The picture's thin lines are resampled by another route in this frame.
    const changed = differing(before, await page.screenshot());
    assert(changed < source.width * source.height * 0.03, `Detail: the first frame differs in ${changed} pixels`);
    for (let index = 0; index < 30; index += 1) await step(page);
    await page.locator("[data-image-preview-collapse]").click();
    let last = await state(page);
    for (let index = 0; index < 22; index += 1) last = await step(page);
    nearRect(last.rect, source, "Detail: the last frame stands on the media frame");
    for (let index = 0; index < 4; index += 1) await step(page);
    assert.equal(await state(page), null, "Detail: it closed");
    // The pointer off the picture again, so its hover controls are gone too.
    await page.mouse.move(VIEWPORT.width - 4, VIEWPORT.height - 4);
    await page.waitForTimeout(300);
    near(differing(before, await page.screenshot()), 0, "Detail: the page is back", 150);

    // ⤢ by a key stands at once.
    await page.locator(frameSelector).hover();
    await page.locator("[data-detail-media-expand-button]").focus();
    await page.keyboard.press("Enter");
    const byKey = await state(page);
    assert.equal(byKey.clipPath, "", "Detail: ⤢ by a key has no flight");
    near(byKey.scrim, 1, "Detail: ⤢ by a key stands at once", 1e-3);
    await page.keyboard.press("Escape");
    assert.equal(await state(page), null, "Detail: Escape closes at once");
    passed(`Detail's media frame: first and last frames on the frame (${changed} pixels), ⤢ by a key at once`);
    await page.close();
  }

  // ── The real clock: frame times ──
  {
    const { page } = await fresh();
    await page.evaluate(() => {
      window.__times = [];
      const record = (time) => {
        window.__times.push(time);
        window.__timer = requestAnimationFrame(record);
      };
      window.__timer = requestAnimationFrame(record);
    });
    await clickSource(page, "#cover");
    await page.waitForFunction(() => {
      const image = document.querySelector("[data-image-preview-image]");
      return image && image.style.visibility !== "hidden" && image.style.clipPath === "";
    });
    const times = await page.evaluate(() => {
      cancelAnimationFrame(window.__timer);
      return window.__times;
    });
    const gaps = times.slice(1).map((time, index) => time - times[index]).filter((gap) => gap > 0);
    const worst = Math.max(...gaps);
    const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    console.log(`FRAMES: ${gaps.length} frames over ${Math.round(times.at(-1) - times[0])} ms, mean ${mean.toFixed(1)} ms, worst ${worst.toFixed(1)} ms`);
    assert(times.at(-1) - times[0] >= 300, "the opening takes its time on the real clock");
    await page.close();
  }
} finally {
  await browser?.close();
  await vite.close();
}
console.log("Image preview motion: all checks passed");
