// The sidebar's thumbnail strips in headless Chromium (SPEC_SIDEBAR_STRIP.md,
// приёмка 4 and 5): the production Sidebar, useSidebarResize,
// SidebarResizeHandle and useChannelPreviewsEvents in a window 2560 × 1000,
// built for production by Vite and served by this script,
// the backend a stand-in that counts `list_channel_previews` and answers
// through a JSON body as the IPC does, the pictures 64 px from this server.
//
// The drag: Everything with 1000 cards and 40 collections of 100, in the
// light and the dark theme, the edge from 280 px to 2170 px and back, 8 px
// and 72 px a frame, each variant twice. From the press to the release no
// read; in every frame every strip holds exactly min(N(W), its list) tiles
// and the last one reaches the strip's right edge, read in that frame after
// the strips' own update by an observer made after theirs; no frame over
// 16.7 ms by Chromium's trace (a frame: the main thread's tasks since the
// last rendering update and the update that paints them), frames over it in a control run with the thumbnail column hidden
// reported apart and not counted against the strips; on the second pass of a
// variant no picture asked of the server; at rest at the widest as many
// tiles as the rows hold.
//
// The full read (ЛМ6): 10 000 cards and 100 collections of 300, read on the
// space's opening and again by events, the sidebar at its narrowest and its
// widest: the longest frame of the page's handling of the answer within
// 16.7 ms. The read itself is the Rust test built optimised as the app is
// (`commands::channels`, its own target folder), its limit asserted;
// `--skip-rust` leaves it out. Builds and serves its own page; touches no dev
// server.
import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { chromium } from "playwright";
import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = "virtual:sidebar-strip-entry";
const RESOLVED_ENTRY = `\0${ENTRY}`;
const route = "/strip.html";
const THUMBS = "/__sidebar-strip-thumbs";
/** How long the first page of the run may take to show. */
const COLD_START_MS = 120_000;
const VIEWPORT = { width: 2560, height: 1000 };
/** The drag's bounds in this window: `S_beside`, and the window less the
 *  narrowest feed (390). */
const MIN_WIDTH = 280;
const MAX_WIDTH = VIEWPORT.width - 390;
const STEPS_PX = [8, 72];
/** The panel's width below which the rows are the List look, without strips
 *  (global.css, «Compact rows», 366.2 px rows and the panel's border). */
const LIST_BELOW_PX = 367.2;
const PASSES = 2;
const FRAME_LIMIT_MS = 16.7;
/** Reads of the large set timed per width: the first opens the space. */
const LARGE_READS = 6;
const skipRust = process.argv.includes("--skip-rust");

/** One picture of the micro level, 64 px, for every card. */
const PICTURE = (() => {
  const png = new PNG({ width: 64, height: 64 });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = 120;
    png.data[index + 1] = 160;
    png.data[index + 2] = 200;
    png.data[index + 3] = 255;
  }
  return PNG.sync.write(png);
})();

// ─── The page ───────────────────────────────────────────────────────────────

/** The page: the sidebar and its stand-in backend alone, as production React
 *  draws it: a frame's time is the app's, not the development build's. */
const entryPlugin = {
  name: "sidebar-strip-entry",
  // The app's pages give way to the one page measured.
  config(config) {
    config.build ??= {};
    config.build.rollupOptions = { ...(config.build.rollupOptions ?? {}), input: { strip: ENTRY } };
  },
  resolveId(id) { return id === ENTRY ? RESOLVED_ENTRY : undefined; },
  load(id) {
    if (id !== RESOLVED_ENTRY) return undefined;
    return `import React from "react";
      import {createRoot} from "react-dom/client";
      import {MemoryRouter} from "react-router";
      import {DndContext, PointerSensor, useSensor, useSensors} from "@dnd-kit/core";
      import {Sidebar} from "/src/components/Sidebar.tsx";
      import {SidebarResizeHandle} from "/src/components/SidebarResizeHandle.tsx";
      import {TooltipProvider} from "/src/components/ui/tooltip.tsx";
      import {useSidebarResize} from "/src/hooks/useSidebarResize.ts";
      import {useChannelPreviewsEvents} from "/src/hooks/useChannelPreviewsEvents.ts";
      import {setSidebarColumnShown} from "/src/lib/sidebarColumnLayout.ts";
      import {sidebarStripTileCount, APP_MAIN_MIN_WIDTH_PX} from "/src/lib/appLayout.ts";
      import "/src/styles/global.css";
      const h=React.createElement, noop=()=>{};
      const large=new URLSearchParams(location.search).get("set")==="large";
      const set=large?{cards:10000,collections:100,members:300}:{cards:1000,collections:40,members:100};
      const slug=(index)=>"card-"+String(index).padStart(5,"0");
      const names=Array.from({length:set.collections},(_,index)=>"Collection "+String(index+1).padStart(3,"0"));
      // Newest first; each card in the same number of collections.
      const lists={__all__:[]};
      for(const name of names) lists[name]=[];
      const memberships=set.collections*set.members/set.cards;
      for(let index=0;index<set.cards;index+=1){
        const item={slug:slug(index),text:index%9===0,mtime:1700000000+index,has_thumb:true};
        lists.__all__.push(item);
        for(let offset=0;offset<memberships;offset+=1) lists[names[(index*memberships+offset)%set.collections]].push(item);
      }
      const previewsJson=JSON.stringify(lists);
      const audit={reads:0,generation:0,unknown:[],
        lengths:Object.fromEntries([["all",set.cards],...names.map((name)=>["tag:"+name,lists[name].length])]),
        tileCount:sidebarStripTileCount};
      window.__audit=audit;
      // The backend: the IPC answers with a JSON body the page parses.
      window.__TAURI_INTERNALS__={
        invoke:async(command)=>{
          if(command==="list_channel_previews"){
            audit.reads+=1;
            audit.generation+=1;
            return new Response('{"generation":'+audit.generation+',"previews":'+previewsJson+'}').json();
          }
          audit.unknown.push(command);
          return null;
        },
        convertFileSrc:(path)=>path,
      };
      window.auditColumns={shown:setSidebarColumnShown};
      const tags=names.map((name)=>({tag:name,count:lists[name].length}));
      function Fixture(){
        const resize=useSidebarResize(null,false);
        const previews=useChannelPreviewsEvents({thumbsRootPath:"${THUMBS}"});
        React.useEffect(()=>{ window.auditRefresh=previews.refresh; },[previews.refresh]);
        return h("div",{className:"relative flex h-screen w-screen overflow-hidden bg-background text-foreground"},
          h(Sidebar,{collapsed:resize.collapsed,widthAnimating:resize.widthAnimating,orderedTags:tags,
            channelPreviews:previews.channelPreviews,totalBlocks:set.cards,isDropDragging:false,isCreatingChannel:false,
            onSetCreatingChannel:noop,onDeleteTag:noop,onRenameTag:noop,onCreateChannel:noop}),
          h(SidebarResizeHandle,{isResizing:resize.isResizing,topRowHost:null,width:resize.width,disabled:false,
            onResizeStart:resize.startResize,onResizeUpdate:resize.updateResize,onResizeEnd:resize.endResize,onResizeTo:resize.resizeTo}),
          h("main",{"data-audit-feed":"",className:"relative min-h-0 flex-1",style:{minWidth:APP_MAIN_MIN_WIDTH_PX}}));
      }
      function Root(){
        const sensors=useSensors(useSensor(PointerSensor,{activationConstraint:{distance:8}}));
        return h(DndContext,{sensors},h(Fixture));
      }
      createRoot(document.getElementById("root")).render(
        h(MemoryRouter,{initialEntries:["/"]},h(TooltipProvider,null,h(Root))));`;
  },
};

const buildFolder = mkdtempSync(join(tmpdir(), "mine-sidebar-strip-"));
await build({
  root,
  configFile: join(root, "vite.config.ts"),
  mode: "production",
  logLevel: "warn",
  plugins: [entryPlugin],
  build: { outDir: buildFolder, emptyOutDir: true, manifest: true, reportCompressedSize: false, chunkSizeWarningLimit: 100_000 },
});
{
  const manifest = JSON.parse(readFileSync(join(buildFolder, ".vite/manifest.json"), "utf8"));
  const chunk = Object.values(manifest).find((item) => item.isEntry);
  if (!chunk) throw new Error("The build has no entry");
  writeFileSync(join(buildFolder, "strip.html"), `<!doctype html><html><head><meta charset="utf-8">${(chunk.css ?? []).map((css) => `<link rel="stylesheet" href="/${css}">`).join("")}</head>`
    + `<body style="margin:0"><div id="root"></div><script type="module" src="/${chunk.file}"></script></body></html>`);
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm" };

/** Pictures the server has sent. */
const served = { pictures: 0 };

/** Serves the build, and the micro level of every card. */
const server = await new Promise((resolveServer) => {
  const http = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith(`${THUMBS}/`)) {
      // As the app's asset protocol answers: no caching headers. Every
      // picture that reaches the server is counted.
      served.pictures += 1;
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(PICTURE);
      return;
    }
    const path = normalize(join(buildFolder, decodeURIComponent(url.pathname)));
    if (!path.startsWith(`${buildFolder}${sep}`) || !existsSync(path) || !statSync(path).isFile()) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream" });
    createReadStream(path).pipe(response);
  });
  http.listen(0, "127.0.0.1", () => {
    const address = http.address();
    resolveServer({ origin: `http://127.0.0.1:${address.port}`, close: () => new Promise((done) => http.close(done)) });
  });
});

// ─── The page's own checks ──────────────────────────────────────────────────

/** Watches every strip in the frame its width changes, after the strips'
 *  observer has updated them: made after theirs, it runs after it. */
function watchStrips() {
  const audit = window.__audit;
  audit.frames = 0;
  audit.wrong = [];
  const check = (strip, width) => {
    const row = strip.closest("[data-sidebar-row-key]")?.getAttribute("data-sidebar-row-key");
    const length = audit.lengths[row];
    if (length === undefined) return;
    const expected = Math.min(audit.tileCount(width), length);
    const track = strip.querySelector("[data-sidebar-strip-track]");
    const tiles = track?.children.length ?? 0;
    let edgeShort = false;
    if (length > expected && tiles > 0) {
      const last = track.lastElementChild.getBoundingClientRect();
      edgeShort = last.right < strip.getBoundingClientRect().right - 0.01;
    }
    if (tiles !== expected || edgeShort) {
      audit.wrong.push({ row, width, expected, tiles, edgeShort });
    }
  };
  audit.observer?.disconnect();
  audit.observer = new ResizeObserver((entries) => {
    audit.frames += 1;
    for (const entry of entries) check(entry.target, entry.contentRect.width);
  });
  for (const strip of document.querySelectorAll("[data-sidebar-thumbnail-strip]")) audit.observer.observe(strip);
}

/** Every strip of the page against its row now. */
function stripsAtRest() {
  const audit = window.__audit;
  let tiles = 0;
  let expected = 0;
  const wrong = [];
  for (const strip of document.querySelectorAll("[data-sidebar-thumbnail-strip]")) {
    const row = strip.closest("[data-sidebar-row-key]")?.getAttribute("data-sidebar-row-key");
    const length = audit.lengths[row];
    if (length === undefined) continue;
    const width = strip.getBoundingClientRect().width;
    const want = Math.min(audit.tileCount(width), length);
    tiles += strip.querySelectorAll("[data-sidebar-preview-thumbnail]").length;
    expected += want;
    const held = strip.querySelector("[data-sidebar-strip-track]")?.children.length ?? 0;
    if (held !== want) wrong.push({ row, width, want, tiles: held });
  }
  return { tiles, expected, wrong, placeholders: document.querySelectorAll("[data-sidebar-preview-placeholder]").length };
}

/** Resolves once the next frame is drawn. */
function frameDrawn() {
  return new Promise((resolve) => requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(0);
  }));
}

// ─── Measuring ──────────────────────────────────────────────────────────────

/** The trace's tasks (`toplevel`) and rendering phases (`devtools.timeline`),
 *  without the detailed timeline's per-call events, which cost the measured
 *  frames time of their own. */
const TRACE_CATEGORIES = ["toplevel", "devtools.timeline"];
const TASK_EVENT = "ThreadControllerImpl::RunTask";
const STEP_MARK = "sidebar-strip-step-";

/** The main thread's frames in a trace, each step's longest: a frame is the
 *  tasks since the last rendering update and the update that draws them (the
 *  task that runs the paint phases, `PrePaint` and `Paint`), its time their
 *  task time. A step runs from its mark (`console.timeStamp`) to the next
 *  one. */
function framesByStep(trace, steps) {
  const events = trace.traceEvents ?? trace;
  const mainThreads = new Set(events
    .filter((event) => event.name === "thread_name" && event.args?.name === "CrRendererMain")
    .map((event) => `${event.pid}:${event.tid}`));
  const onMain = (event) => event.ph === "X" && mainThreads.has(`${event.pid}:${event.tid}`);
  const tasks = events.filter((event) => event.name === TASK_EVENT && onMain(event)).sort((a, b) => a.ts - b.ts);
  const updates = events.filter((event) => (event.name === "PrePaint" || event.name === "Paint") && onMain(event)).map((event) => event.ts).sort((a, b) => a - b);
  const marks = events
    .filter((event) => event.name === "TimeStamp" && event.args?.data?.message?.startsWith(STEP_MARK))
    .map((event) => ({ ts: event.ts, step: Number(event.args.data.message.slice(STEP_MARK.length)) }))
    .sort((a, b) => a.ts - b.ts);
  const longest = new Array(steps).fill(0);
  let frame = 0;
  let update = 0;
  let mark = -1;
  for (const task of tasks) {
    while (mark + 1 < marks.length && marks[mark + 1].ts <= task.ts) mark += 1;
    frame += task.dur / 1000;
    while (update < updates.length && updates[update] < task.ts) update += 1;
    const draws = update < updates.length && updates[update] <= task.ts + task.dur;
    if (!draws) continue;
    const step = mark >= 0 ? marks[mark].step : -1;
    if (step >= 0 && step < steps) longest[step] = Math.max(longest[step], frame);
    frame = 0;
  }
  return longest;
}

/** The edge's positions of one way of a drag from `from` to `to`. */
function positions(from, to, step) {
  const out = [];
  const sign = Math.sign(to - from);
  for (let width = from + sign * step; sign > 0 ? width < to : width > to; width += sign * step) out.push(width);
  out.push(to);
  return out;
}

/** Drags the edge from MIN_WIDTH to MAX_WIDTH and back, `step` a frame.
 *  Returns each frame's main-thread time and what the drag read and asked. */
async function drag(browser, page, step, pictures) {
  const handle = page.locator('[role="separator"][data-sidebar-resize-handle]');
  const box = await handle.boundingBox();
  const x0 = box.x + box.width / 2;
  const y = box.y + 200;
  // The handle's centre is the panel's last pixel: the edge is `width` there.
  const edgeAt = (width) => x0 + (width - MIN_WIDTH);
  await page.evaluate(watchStrips);
  const readsBefore = await page.evaluate(() => window.__audit.reads);
  const picturesBefore = pictures.count;
  await page.mouse.move(x0, y);
  await page.mouse.down();
  const widths = [...positions(MIN_WIDTH, MAX_WIDTH, step), ...positions(MAX_WIDTH, MIN_WIDTH, step)];
  await browser.startTracing(page, { categories: TRACE_CATEGORIES });
  for (const [index, width] of widths.entries()) {
    await page.evaluate((mark) => console.timeStamp(mark), `${STEP_MARK}${index}`);
    await page.mouse.move(edgeAt(width), y);
    await page.evaluate(frameDrawn);
  }
  await page.evaluate((mark) => console.timeStamp(mark), `${STEP_MARK}${widths.length}`);
  const trace = JSON.parse((await browser.stopTracing()).toString("utf8"));
  const longest = framesByStep(trace, widths.length);
  const frames = widths.map((width, index) => ({ width, ms: longest[index] }));
  const readsDuring = (await page.evaluate(() => window.__audit.reads)) - readsBefore;
  await page.mouse.up();
  await page.evaluate(frameDrawn);
  const watched = await page.evaluate(() => ({ frames: window.__audit.frames, wrong: window.__audit.wrong }));
  return { frames, readsDuring, pictures: pictures.count - picturesBefore, watched };
}

/** The page's main-thread tasks while `act` runs, from Chromium's trace:
 *  each task's duration, ms. */
async function tracedTasks(browser, page, act) {
  await browser.startTracing(page, { categories: TRACE_CATEGORIES });
  await act();
  const trace = JSON.parse((await browser.stopTracing()).toString("utf8"));
  const events = trace.traceEvents ?? trace;
  const mainThreads = new Set(events
    .filter((event) => event.name === "thread_name" && event.args?.name === "CrRendererMain")
    .map((event) => `${event.pid}:${event.tid}`));
  return events
    .filter((event) => event.name === TASK_EVENT && event.ph === "X" && mainThreads.has(`${event.pid}:${event.tid}`))
    .map((event) => event.dur / 1000);
}

/** Reads the large set `LARGE_READS` times as events would, each until the
 *  page has drawn ten frames after the answer. */
async function readAgain(page) {
  for (let index = 0; index < LARGE_READS; index += 1) {
    await page.evaluate(async () => {
      await window.auditRefresh();
      for (let frame = 0; frame < 10; frame += 1) {
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
  }
}

const round = (value) => Math.round(value * 10) / 10;
/** The `share` percentile of the frames' times, ms. */
function percentile(frames, share) {
  const sorted = frames.map((frame) => frame.ms).sort((a, b) => a - b);
  return round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))]);
}
const showFrames = (frames) => JSON.stringify(frames.slice(0, 6).map((frame) => ({ width: frame.width, ms: round(frame.ms) })));

// ─── The Rust read ──────────────────────────────────────────────────────────

/** The Rust test of the full read built optimised as the app is, in a target
 *  folder of its own; it asserts its limit (ЛМВ1). */
function runRustTest() {
  return new Promise((resolveRun) => {
    const child = spawn("node", ["scripts/run-with-disposable-home.mjs", "cargo", "test", "-p", "mine", "--lib", "--features", "tooling", "--locked",
      "commands::channels::tests::a_full_preview_read_of_a_large_space_answers_within_its_limit", "--", "--nocapture"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CARGO_TARGET_DIR: join(root, "target/sidebar-strip"),
        CARGO_PROFILE_DEV_OPT_LEVEL: "3",
        CARGO_PROFILE_TEST_OPT_LEVEL: "3",
        MINE_SIDEBAR_PREVIEW_TIMING: "assert",
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => {
      const line = /list_channel_previews, .*asserted/.exec(output)?.[0] ?? null;
      resolveRun({ passed: code === 0 && /1 passed/.test(output), line, tail: output.split("\n").slice(-8).join("\n") });
    });
  });
}

// ─── The run ────────────────────────────────────────────────────────────────

const readyRow = () => document.querySelector('[data-sidebar-row-key="all"] [data-sidebar-previews="ready"]') !== null;
const tenFrames = async () => {
  for (let frame = 0; frame < 10; frame += 1) await new Promise((resolve) => requestAnimationFrame(() => resolve()));
};

let browser;
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const pictures = { get count() { return served.pictures; } };

  await page.goto(new URL(route, server.origin).href);
  await page.waitForFunction(readyRow, null, { timeout: COLD_START_MS });
  // The narrowest sidebar beside the feed, from the separator's keys.
  await page.locator('[role="separator"][data-sidebar-resize-handle]').focus();
  await page.keyboard.press("Home");
  await page.locator("[data-audit-feed]").click();
  await page.evaluate(frameDrawn);

  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await page.evaluate(frameDrawn);
    for (const step of STEPS_PX) {
      const variant = `${theme}, ${step} px a frame`;
      const passes = [];
      for (let pass = 1; pass <= PASSES; pass += 1) {
        const name = `${variant}, pass ${pass}`;
        const run = await drag(browser, page, step, pictures);
        // At rest at the widest, as the drag's turn left it, and back.
        await page.locator('[role="separator"][data-sidebar-resize-handle]').focus();
        await page.keyboard.press("End");
        await page.evaluate(frameDrawn);
        const rest = await page.evaluate(stripsAtRest);
        await page.keyboard.press("Home");
        await page.locator("[data-audit-feed]").click();
        await page.evaluate(frameDrawn);
        // The control: the same drag with the thumbnail column hidden. A
        // frame over the limit there at the same place is not the strips'.
        await page.evaluate(() => window.auditColumns.shown("previews", false));
        await page.evaluate(frameDrawn);
        const control = await drag(browser, page, step, { count: 0 });
        await page.evaluate(() => window.auditColumns.shown("previews", true));
        await page.evaluate(frameDrawn);
        passes.push({ run, control });
        const over = run.frames.filter((frame) => frame.ms > FRAME_LIMIT_MS);
        const controlOver = control.frames.filter((frame) => frame.ms > FRAME_LIMIT_MS);
        const longest = Math.max(...run.frames.map((frame) => frame.ms));
        console.log(`${name}: ${run.frames.length} frames, median ${percentile(run.frames, 0.5)} ms, 95th ${percentile(run.frames, 0.95)} ms, the longest ${round(longest)} ms (the control: median ${percentile(control.frames, 0.5)}, 95th ${percentile(control.frames, 0.95)}); over ${FRAME_LIMIT_MS} ms: ${over.length} ${showFrames(over)}; the control's own over it: ${controlOver.length} ${showFrames(controlOver)}; reads ${run.readsDuring}; pictures asked ${run.pictures}; frames the strips changed in ${run.watched.frames}, off their width ${run.watched.wrong.length}; at rest ${rest.tiles} tiles of ${rest.expected}`);
        check(run.readsDuring === 0, `${name}: ${run.readsDuring} reads of list_channel_previews during the drag`);
        // Below the List look's threshold the strips are not laid out and
        // keep their 0 width; every frame above it changes their width.
        const laidOut = run.frames.filter((frame) => frame.width > LIST_BELOW_PX).length;
        check(run.watched.frames >= laidOut, `${name}: the strips changed in only ${run.watched.frames} of the ${laidOut} frames they are laid out in`);
        check(run.watched.wrong.length === 0, `${name}: strips off their width: ${JSON.stringify(run.watched.wrong.slice(0, 5))}`);
        if (pass > 1) check(run.pictures === 0, `${name}: ${run.pictures} pictures asked for on the second pass`);
        check(rest.wrong.length === 0 && rest.tiles === rest.expected && rest.placeholders === 0,
          `${name}: at rest ${rest.tiles} tiles of ${rest.expected}: ${JSON.stringify(rest.wrong.slice(0, 5))}`);
      }
      // A frame is the strips' when it is over the limit at the same place
      // on both passes and on neither control: a long frame of the
      // machine's other work does not come back at the same place (as
      // `test:editing-perf` judges its scroll).
      const steps = passes[0].run.frames.map((frame, index) => ({
        width: frame.width,
        ms: Math.min(...passes.map(({ run }) => run.frames[index].ms)),
        controlMs: Math.max(...passes.map(({ control }) => control.frames[index].ms)),
      }));
      const strips = steps.filter((frame) => frame.ms > FRAME_LIMIT_MS && !(frame.controlMs > FRAME_LIMIT_MS));
      const once = passes[0].run.frames.filter((_, index) =>
        passes.some(({ run }) => run.frames[index].ms > FRAME_LIMIT_MS)).length - strips.length;
      console.log(`${variant}: frames over ${FRAME_LIMIT_MS} ms at the same place on both passes, not in the control: ${strips.length}; over on one pass only or in the control too, not the strips': ${once}`);
      check(strips.length === 0, `${variant}: frames over ${FRAME_LIMIT_MS} ms on both passes, not in the control: ${showFrames(strips)}`);
    }
  }
  const unknown = await page.evaluate(() => window.__audit.unknown);
  if (unknown.length > 0) console.log(`commands other than the read: ${[...new Set(unknown)].join(", ")}`);
  await page.close();

  // The full read of the large set, at the narrowest and the widest sidebar.
  const large = await context.newPage();
  large.on("pageerror", (error) => errors.push(error.message));
  await large.goto(new URL(`${route}?set=large`, server.origin).href);
  await large.waitForFunction(readyRow, null, { timeout: COLD_START_MS });
  for (const [label, key] of [["narrowest", "Home"], ["widest", "End"]]) {
    await large.locator('[role="separator"][data-sidebar-resize-handle]').focus();
    await large.keyboard.press(key);
    await large.evaluate(tenFrames);
    const again = await tracedTasks(browser, large, () => readAgain(large));
    const longest = Math.max(...again);
    console.log(`the full read of 10 000 cards and 100 collections of 300, the sidebar at its ${label}: the longest task of ${LARGE_READS} reads ${round(longest)} ms`);
    check(longest <= FRAME_LIMIT_MS, `the full read, the sidebar at its ${label}: a task of ${round(longest)} ms over ${FRAME_LIMIT_MS} ms`);
  }
  check(errors.length === 0, `page errors: ${errors.join("; ")}`);

  if (!skipRust) {
    console.log("sidebar-strip: the Rust test of the full read in an optimised build");
    const rust = await runRustTest();
    console.log(rust.line ?? rust.tail);
    check(rust.passed, `the Rust test of the full read:\n${rust.tail}`);
  }
} finally {
  await browser?.close();
  await server.close();
  rmSync(buildFolder, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`FAIL\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("PASS sidebar-strip");
