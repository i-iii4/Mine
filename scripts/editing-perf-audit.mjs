// The editor's performance in headless Chromium (SPEC_EDITING.md, Л14): the
// editing page (`src/dev/EditingPage.tsx`, its made-up backend serializing
// what crosses the IPC as Tauri does) built for production by Vite into a
// folder of the run, served from there, and every set of Л14.2 opened in it
// (`src/dev/editingPerfSets.ts`, the table cases, the reading mode's
// fixture). Measured against the limits of Л14.3:
//
// - typing: the main thread's work from a key to the drawn frame that shows
//   it (Chromium's own count of task time over the key and two frames), the
//   95th percentile of 60 keys at every place typed at, once the parser has
//   read the note; writes answer after the frame, as a disk and the IPC
//   would, and their answers are measured apart;
// - scrolling top to bottom and back a view a frame: no frame longer than
//   50 ms (`long-animation-frame`); a first pass, three views a frame, draws
//   the widgets and fills the caches; a measured pass with long frames runs
//   once more and the better pass is judged, for a long frame of the
//   machine's other work does not come back at the same place;
// - entering editing on the fixture with the editor's part already loaded:
//   the first frame of the editor, without raw markup;
// - loading the editor's part of the build;
// - memory: the open card with its editor holds the document once, not
//   twice: from 1 MB to 10 MB of prose its heap grows by under 2.5 copies
//   of the text added, the card's own content text one of them;
// - `save_note_body` on a note of 100 KB: the Rust test built optimised as
//   the app is (`opt-level` 3, the target folder `target/editing-perf`).
//
// A limit a measure does not hold, where SPEC_EDITING.md names the
// exception and the decision it waits for (`KNOWN_EXCEEDANCES`), is reported
// as that exception: the audit fails when the measure gets worse than the
// exception's ceiling or holds the limit again (the exception is then
// stale). Every other limit must hold. The report goes to
// `output/playwright/editing-perf-<time>/report.json`.
//
// `--skip-rust` leaves out the Rust test, `--sets=a,b` measures those sets
// only. Starts and stops its own build and server; touches no dev server.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { chromium } from 'playwright';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = 'virtual:editing-perf-entry';
const RESOLVED_ENTRY = `\0${ENTRY}`;
const VIEWPORT = { width: 1600, height: 800 };
/** How long a page waits for the editor of a note of 10 MB. */
const OPEN_TIMEOUT_MS = 180_000;

/** Л14.3. */
const LIMITS = {
  typingP95Ms: 16,
  longFrameMs: 50,
  entryMs: 150,
  chunkLoadMs: 100,
  /** The open card with its editor holds the note's text twice and not
   *  more: the card's content text, which the open card derives in either
   *  mode (`deriveCardContent`, its preview without the markup), and the
   *  editor's document; a second copy of the document would be a third.
   *  What the heap grows by from 1 MB to 10 MB of prose stays under this
   *  many copies of the text added. */
  memoryCopies: 2.5,
};

/** Keys typed at every place; the 95th percentile is the third highest. */
const KEYSTROKES = 60;
/** A write answers this long after it is sent: after the key's frame, as
 *  the IPC and a disk do, so its answer is measured apart. */
const SAVE_DELAY_MS = 60;
/** Scroll steps a frame, in heights of the view: the first pass reaches
 *  every place fast, the measured one scrolls as a fast fling does, a view a
 *  frame (48 000 px a second at 60 frames). */
const WARM_STEP_VIEWS = 3;
const SCROLL_STEP_VIEWS = 1;
/** Most frames one way of a scroll pass. */
const SCROLL_MAX_FRAMES = 4000;
/** Runs of entering editing and of loading the editor's part. */
const ENTRY_RUNS = 5;
const CHUNK_RUNS = 3;

/**
 * The exceptions SPEC_EDITING.md names (Л14, «Исключения»). Each is a
 * measure of one place of one set that does not hold its limit, with what
 * it was measured at and the ceiling past which it is a regression.
 */
const KNOWN_EXCEEDANCES = [
  {
    id: 'И1',
    set: 'large-table',
    places: ['a cell of the long table'],
    measure: 'typingP95Ms',
    ceilingMs: 90,
    why: 'a key in a cell of the table of 5000 rows: @lezer/markdown parses the whole table again as one block',
    waitsFor: 'the user\'s decision on the parser of large blocks (PLAN 50.21, 50.28; SPEC_EDITING.md, Л14, «Исключения»)',
  },
  {
    id: 'И2',
    set: 'prose-10mb',
    places: ['the paragraph at the top', 'the paragraph in the middle'],
    measure: 'typingP95Ms',
    ceilingMs: 60,
    why: 'every key writes the whole body: 10 MB taken out of the document and serialized for the IPC, from 4 MB up typing does not hold its limit',
    waitsFor: 'the user\'s decision on the size threshold of Л14.4 and the writes of large notes (PLAN 50.28; SPEC_EDITING.md, Л14, «Исключения»)',
  },
  {
    id: 'И3',
    set: 'tasks-10k',
    places: ['the paragraph in the middle'],
    measure: 'typingP95Ms',
    ceilingMs: 45,
    why: 'a key in a paragraph right after a list of 1000 items: @lezer/markdown parses the whole list again',
    waitsFor: 'the user\'s decision on the parser of large blocks (PLAN 50.28; SPEC_EDITING.md, Л14, «Исключения»)',
  },
  {
    id: 'И4',
    set: 'large-table',
    places: [null],
    measure: 'longFrameMs',
    ceilingMs: 150,
    // Not every pass has such a frame: a pass without one is no stale
    // exception.
    intermittent: true,
    why: 'scrolling the table of 5000 rows after typing in it: the rows drawn are parsed again through the reading pipeline whenever their window moves, about 100 rows of a GFM table, and a frame now and then goes past the limit',
    waitsFor: 'the user\'s decision on large tables, with И1 (PLAN 50.21, 50.28; SPEC_EDITING.md, Л14, «Исключения»)',
  },
];

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

/** Where text is typed in each set: a place found in the document, or a
 *  cell of a table clicked as a person does. */
const TOP = { kind: 'text', label: 'the paragraph at the top', after: 'Абзац для набора в начале заметки' };
const MIDDLE = { kind: 'text', label: 'the paragraph in the middle', after: 'Абзац для набора в середине заметки' };
const SETS = [
  { name: 'fixture', places: [{ kind: 'text', label: 'a paragraph', after: 'Сноска в конце предложения' }, { kind: 'text', label: 'a heading', after: '## Заголовок второго уровня' }, { kind: 'text', label: 'a task', after: 'Невыполненная задача' }], memory: true },
  { name: 'prose-1mb', places: [TOP, MIDDLE], memory: true },
  { name: 'prose-10mb', places: [TOP, MIDDLE], memory: true },
  { name: 'headings-10k', places: [TOP, MIDDLE, { kind: 'text', label: 'a heading', after: '### Заголовок 5' }] },
  { name: 'tasks-10k', places: [TOP, MIDDLE, { kind: 'text', label: 'a nested task', after: '  - [ ] Пункт 4' }] },
  { name: 'images-1000', places: [TOP, MIDDLE] },
  { name: 'mermaid-100', places: [TOP, MIDDLE] },
  { name: 'large-table', places: [{ kind: 'text', label: 'the paragraph before the table', after: 'Абзац перед таблицей' }, { kind: 'cell', label: 'a cell of the long table', row: 3, col: 2 }] },
  { name: 'wide-table', places: [{ kind: 'text', label: 'the paragraph before the table', after: 'Абзац перед таблицей' }, { kind: 'cell', label: 'a cell of the wide table', row: 2, col: 1 }] },
  { name: 'tables-200', places: [TOP, MIDDLE, { kind: 'cell', label: 'a cell of the first table', row: 2, col: 1 }] },
];

/** Prose between 1 MB and 10 MB, typed at its top only: the smallest size
 *  where typing does not hold its limit is the size threshold of Л14.4. */
const THRESHOLD_MEGABYTES = [2, 4, 6, 8];

const only = args.get('sets')?.split(',');
const sets = only ? SETS.filter((set) => only.includes(set.name)) : SETS;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runFolder = resolve(process.env.MINE_EDITING_PERF_RUN ?? join(root, 'output/playwright', `editing-perf-${stamp}`));
mkdirSync(runFolder, { recursive: true });
const buildFolder = mkdtempSync(join(tmpdir(), 'mine-editing-perf-'));

// ─── The build ──────────────────────────────────────────────────────────────

/** The page: the editing page alone, as production React draws it. */
function perfEntryPlugin() {
  return {
    name: 'editing-perf-entry',
    // The app's three pages give way to the one page measured.
    config(config) {
      config.build ??= {};
      config.build.rollupOptions = { ...(config.build.rollupOptions ?? {}), input: { perf: ENTRY } };
    },
    resolveId(id) { return id === ENTRY ? RESOLVED_ENTRY : undefined; },
    load(id) {
      if (id !== RESOLVED_ENTRY) return undefined;
      return `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import '/src/styles/global.css';
        import { EditingPage } from '/src/dev/EditingPage.tsx';
        // The editor's part, as Detail loads it at the first entry (Л0.6).
        window.__editingPerf = { loadEditor: () => import('/src/components/editing/NoteEditor.tsx') };
        createRoot(document.getElementById('root')).render(React.createElement(EditingPage));`;
    },
  };
}

async function buildPage() {
  const started = Date.now();
  await build({
    root,
    configFile: join(root, 'vite.config.ts'),
    mode: 'production',
    logLevel: 'warn',
    plugins: [perfEntryPlugin()],
    build: { outDir: buildFolder, emptyOutDir: true, manifest: true, reportCompressedSize: false, chunkSizeWarningLimit: 100_000 },
  });
  const manifest = JSON.parse(readFileSync(join(buildFolder, '.vite/manifest.json'), 'utf8'));
  const entry = Object.values(manifest).find((chunk) => chunk.isEntry);
  assert(entry, 'the build has its entry');
  writeFileSync(join(buildFolder, 'perf.html'), `<!doctype html><html><head><meta charset="utf-8">${(entry.css ?? []).map((css) => `<link rel="stylesheet" href="/${css}">`).join('')}</head>`
    + `<body><div id="root" style="height:100vh"></div><script type="module" src="/${entry.file}"></script></body></html>`);
  const editor = Object.values(manifest).find((chunk) => chunk.src === 'src/components/editing/NoteEditor.tsx');
  assert(editor, 'the build has the editor\'s part');
  const editorBytes = readFileSync(join(buildFolder, editor.file));
  return { ms: Date.now() - started, editorChunk: { file: editor.file, bytes: editorBytes.length, gzip: gzipSync(editorBytes, { level: 9 }).length } };
}

// ─── The server ─────────────────────────────────────────────────────────────

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' };

/** The picture an even number of `images-1000` shows. */
function picture() {
  const png = new PNG({ width: 160, height: 100 });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = 120;
    png.data[index + 1] = 140;
    png.data[index + 2] = 170;
    png.data[index + 3] = 255;
  }
  return PNG.sync.write(png);
}

function startServer() {
  const image = picture();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/media/')) {
      const name = decodeURIComponent(url.pathname.slice('/media/'.length));
      const number = /^Картинка (\d+)\.png$/.exec(name)?.[1];
      if (number && Number(number) % 2 === 0) {
        response.writeHead(200, { 'Content-Type': 'image/png' });
        response.end(image);
      } else {
        response.writeHead(404);
        response.end();
      }
      return;
    }
    const path = normalize(join(buildFolder, decodeURIComponent(url.pathname)));
    if (!path.startsWith(`${buildFolder}${sep}`) || !existsSync(path) || !statSync(path).isFile()) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' });
    createReadStream(path).pipe(response);
  });
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolveServer({ origin: `http://127.0.0.1:${address.port}`, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

// ─── Measuring in the page ──────────────────────────────────────────────────

/** Helpers the page gets before it runs. */
function installPageHelpers() {
  window.__perf = {
    /** Resolves after the next frame is drawn. */
    frame: () => new Promise((resolveFrame) => requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolveFrame(performance.now());
      channel.port2.postMessage(0);
    })),
    long: [],
  };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__perf.long.push(entry.startTime + entry.duration);
  }).observe({ type: 'longtask', buffered: true });
}

/** Wait until the page has had no long task for `quietMs`. */
async function settle(page, quietMs = 600, maxMs = 60_000) {
  await page.evaluate(async ([quiet, max]) => {
    const started = performance.now();
    for (;;) {
      await window.__perf.frame();
      const last = window.__perf.long.at(-1) ?? 0;
      const now = performance.now();
      if (now - Math.max(last, started) >= quiet || now - started > max) return;
      await new Promise((done) => setTimeout(done, 50));
    }
  }, [quietMs, maxMs]);
}

async function taskSeconds(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return metrics.find((metric) => metric.name === 'TaskDuration')?.value ?? 0;
}

const KEY = { key: 'x', code: 'KeyX', text: 'x', unmodifiedText: 'x', windowsVirtualKeyCode: 88, nativeVirtualKeyCode: 88 };

async function press(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...KEY });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: KEY.key, code: KEY.code, windowsVirtualKeyCode: 88, nativeVirtualKeyCode: 88 });
}

/** The work the measuring itself costs: the same window without a key. */
async function overheadMs(page, cdp) {
  const samples = [];
  for (let index = 0; index < 8; index += 1) {
    const before = await taskSeconds(cdp);
    await page.evaluate(() => window.__perf.frame().then(() => window.__perf.frame()));
    samples.push((await taskSeconds(cdp) - before) * 1000);
  }
  return median(samples);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)];
}

function percentile(values, share) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.ceil(sorted.length * share) - 1];
}

const round = (value) => Math.round(value * 10) / 10;

/** Wait for `selector` without keeping a handle on the element: a handle
 *  would keep a closed editor, and the note it held, alive in the heap. */
async function appears(page, selector, timeout = OPEN_TIMEOUT_MS) {
  await page.waitForFunction((css) => document.querySelector(css) !== null, selector, { timeout, polling: 'raf' });
}

/** Put the caret where `place` says, as a person would: the paragraph by
 *  its text, a cell by a press on it. */
async function reach(page, place) {
  if (place.kind === 'text') {
    const at = await page.evaluate(async (after) => {
      const text = await window.__editing.editor.text();
      const index = text.indexOf(after);
      return index < 0 ? -1 : index + after.length;
    }, place.after);
    assert(at >= 0, `the note has “${place.after}”`);
    await page.evaluate((pos) => window.__editing.editor.select(pos), at);
    return;
  }
  const point = await page.evaluate(({ row, col }) => {
    const table = document.querySelector("[data-editor-block='table']");
    const cell = table?.querySelector(`[data-table-row='${row}'][data-table-col='${col}']`);
    if (!cell) return null;
    cell.scrollIntoView({ block: 'center' });
    const rect = cell.getBoundingClientRect();
    return { x: rect.left + 4, y: rect.top + rect.height / 2 };
  }, place);
  assert(point, `the table has its cell ${place.row}, ${place.col}`);
  await page.waitForTimeout(200);
  await page.mouse.click(point.x, point.y);
  await appears(page, '[data-table-cell-editor] .cm-content');
  await page.keyboard.press('End');
}

/** Type `KEYSTROKES` keys at the caret: each key's work to its frame, and
 *  the work of its write's answer. */
async function typeAt(page, cdp, overhead) {
  const keys = [];
  const answers = [];
  for (let index = 0; index < KEYSTROKES; index += 1) {
    const writes = await page.evaluate(() => window.__editing.record.writes.length);
    const before = await taskSeconds(cdp);
    await press(cdp);
    await page.evaluate(() => window.__perf.frame().then(() => window.__perf.frame()));
    const framed = await taskSeconds(cdp);
    keys.push(Math.max(0, (framed - before) * 1000 - overhead));
    await page.evaluate(async (count) => {
      const deadline = performance.now() + 30_000;
      while (window.__editing.record.writes.length <= count && performance.now() < deadline) {
        await new Promise((done) => setTimeout(done, 10));
      }
      await window.__perf.frame();
      await window.__perf.frame();
    }, writes);
    answers.push(Math.max(0, (await taskSeconds(cdp) - framed) * 1000 - overhead));
  }
  return {
    p95: round(percentile(keys, 0.95)),
    median: round(median(keys)),
    max: round(Math.max(...keys)),
    answerP95: round(percentile(answers, 0.95)),
  };
}

/** Scroll the open card from the top to the bottom and back, a few views a
 *  frame: the frames longer than the limit and their scripts. */
async function scrollPass(page, stepViews) {
  return page.evaluate(async ([stepViews, maxFrames, limit]) => {
    const scroller = document.querySelector('[data-detail-scroll]');
    const long = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        long.push({
          ms: Math.round(entry.duration),
          scripts: (entry.scripts ?? []).slice(0, 3).map((script) => `${script.invoker ?? ''} ${Math.round(script.duration)} ms`),
        });
      }
    });
    observer.observe({ type: 'long-animation-frame', buffered: false });
    let frames = 0;
    let worstGap = 0;
    // Where the pass stood every so many frames: a pass that does not get
    // through shows where it stuck.
    const trail = [];
    let last = await window.__perf.frame();
    const step = scroller.clientHeight * stepViews;
    for (const direction of [1, -1]) {
      for (let count = 0; count < maxFrames; count += 1) {
        const before = scroller.scrollTop;
        scroller.scrollTop = before + direction * step;
        const now = await window.__perf.frame();
        worstGap = Math.max(worstGap, now - last);
        last = now;
        frames += 1;
        if (frames % 250 === 0) trail.push([frames, Math.round(scroller.scrollTop), Math.round(scroller.scrollHeight)]);
        const atEnd = direction > 0
          ? scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2
          : scroller.scrollTop <= 0;
        if (atEnd && Math.abs(scroller.scrollTop - before) < 1) break;
      }
    }
    await window.__perf.frame();
    observer.disconnect();
    return { frames, longFrames: long.filter((entry) => entry.ms > limit), worstGapMs: Math.round(worstGap), trail };
  }, [stepViews, SCROLL_MAX_FRAMES, LIMITS.longFrameMs]);
}

async function heapBytes(cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  return usedSize;
}

async function waitForEditor(page) {
  await appears(page, '.mine-note-editor .cm-content');
  await page.evaluate(() => document.fonts.ready);
}

/** Wait until the parser has read the whole note: the parse is the
 *  editor's background work of opening a note, not of typing (Л5.6). */
async function waitForParse(page) {
  await page.waitForFunction(async () => {
    const parsed = await window.__editing.editor.parsed();
    return parsed !== null && parsed.to >= parsed.length;
  }, null, { timeout: OPEN_TIMEOUT_MS, polling: 250 });
}

async function measureSet(browser, origin, set) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(installPageHelpers);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const body = set.name === 'fixture' ? '' : `&body=${set.name}`;
  const opened = Date.now();
  await page.goto(`${origin}/perf.html?theme=light${body}`, { waitUntil: 'domcontentloaded' });
  await waitForEditor(page);
  const openMs = Date.now() - opened;
  await page.evaluate((ms) => window.__editing.setSaveDelay(ms), SAVE_DELAY_MS);
  // The editor takes the focus: its parser works on while it has it (Л5.6).
  const ready = async () => {
    await page.evaluate(() => window.__editing.editor.select(0));
    await waitForParse(page);
    await settle(page);
  };
  await ready();
  const parsedMs = Date.now() - opened;
  // What the open card with its editor holds, before any edit: the heap
  // with the card open, then closed. The note's file stays in the made-up
  // backend and the reading pipeline's caches in their module: both are in
  // either count.
  let heap = null;
  if (set.memory) {
    const open = await heapBytes(cdp);
    await page.evaluate(() => window.__editing.setOpen(false));
    await page.waitForFunction(() => !document.querySelector('.mine-note-editor'));
    await settle(page, 300);
    heap = {
      editorBytes: open - (await heapBytes(cdp)),
      documentChars: await page.evaluate(() => window.__editing.body().length),
    };
    await page.evaluate(() => window.__editing.setOpen(true));
    await waitForEditor(page);
    await ready();
  }
  const overhead = await overheadMs(page, cdp);

  const typing = [];
  for (const place of set.places) {
    // The garbage of what came before is collected first: its pauses are
    // none of these keys'.
    await cdp.send('HeapProfiler.collectGarbage');
    await reach(page, place);
    await settle(page, 300);
    typing.push({ place: place.label, ...(await typeAt(page, cdp, overhead)) });
    await page.keyboard.press('Escape');
  }
  const accepted = await page.evaluate(() => window.__editing.record.writes.every((write) => write.accepted));
  let warm = null;
  let scroll = null;
  if (set.scroll !== false) {
    // The first pass draws every widget once and fills the caches; the
    // second is measured. The garbage of the typing before is collected
    // first: its pauses are no frame of the scroll.
    await page.evaluate(() => window.__editing.editor.select(0));
    await settle(page, 300);
    warm = await scrollPass(page, WARM_STEP_VIEWS);
    await cdp.send('HeapProfiler.collectGarbage');
    await settle(page, 300);
    scroll = await scrollPass(page, SCROLL_STEP_VIEWS);
    // A long frame of the machine's other work does not come back at the
    // same place; one of the editor does. A pass with long frames is run
    // once more and the better of the two is judged; both are reported.
    if (scroll.longFrames.length > 0) {
      await cdp.send('HeapProfiler.collectGarbage');
      await settle(page, 300);
      const again = await scrollPass(page, SCROLL_STEP_VIEWS);
      const longest = (pass) => Math.max(0, ...pass.longFrames.map((frame) => frame.ms));
      scroll = longest(again) < longest(scroll) ? { ...again, previous: scroll } : { ...scroll, previous: again };
    }
  }
  await context.close();
  return { name: set.name, openMs, parsedMs, overheadMs: round(overhead), typing, accepted, warmLongFrames: warm?.longFrames.length ?? null, scroll, heap, errors };
}

/** The editor's part loaded from the build, the page in the reading mode
 *  until then (Л0.6). */
async function measureChunk(browser, origin) {
  const runs = [];
  for (let index = 0; index < CHUNK_RUNS; index += 1) {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    await page.addInitScript(installPageHelpers);
    await page.goto(`${origin}/perf.html?theme=light&editing=off`, { waitUntil: 'domcontentloaded' });
    await appears(page, '[data-article-body]');
    await settle(page, 400);
    runs.push(await page.evaluate(async () => {
      const started = performance.now();
      await window.__editingPerf.loadEditor();
      const ms = performance.now() - started;
      const files = performance.getEntriesByType('resource')
        .filter((entry) => entry.startTime >= started)
        .map((entry) => ({ file: entry.name.split('/').pop(), bytes: entry.decodedBodySize }));
      return { ms, files };
    }));
    await context.close();
  }
  return {
    ms: round(median(runs.map((run) => run.ms))),
    bytes: runs[0]?.files.reduce((sum, file) => sum + file.bytes, 0) ?? 0,
    runs: runs.map((run) => ({ ms: round(run.ms), files: run.files })),
  };
}

/** Entering editing on the fixture, the editor's part loaded: from the
 *  switch to the first drawn frame of the editor, and whether that frame
 *  shows the article's look rather than raw markup (Л5.4). */
async function measureEntry(browser, origin) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await page.addInitScript(installPageHelpers);
  await page.goto(`${origin}/perf.html?theme=light`, { waitUntil: 'domcontentloaded' });
  await waitForEditor(page);
  await settle(page);
  const runs = [];
  for (let index = 0; index < ENTRY_RUNS; index += 1) {
    await page.evaluate(() => window.__editing.setEditing(false));
    await appears(page, '[data-article-body]');
    await page.waitForFunction(() => !document.querySelector('.mine-note-editor'));
    await settle(page, 400);
    runs.push(await page.evaluate(async () => {
      const started = performance.now();
      window.__editing.setEditing(true);
      for (;;) {
        const drawn = await window.__perf.frame();
        const content = document.querySelector('.mine-note-editor .cm-content');
        if (content) {
          // The first lines hold a heading and a paragraph with bold words:
          // drawn, neither `#` nor `**` shows.
          const lines = [...content.querySelectorAll('.cm-line')].map((line) => line.textContent ?? '').filter((line) => line.trim()).slice(0, 5);
          return { ms: drawn - started, lines: lines.length, raw: lines.length === 0 || lines.some((line) => /^#{1,6} |\*\*/.test(line)) };
        }
        if (drawn - started > 10_000) return { ms: drawn - started, lines: 0, raw: true };
      }
    }));
  }
  await context.close();
  return { ms: round(median(runs.map((run) => run.ms))), runs: runs.map((run) => ({ ...run, ms: round(run.ms) })) };
}

/** The Rust test of `save_note_body` built optimised as the app is, with
 *  the debug assertions the tests need, in a target folder of its own so the
 *  everyday test build stays as it is; the test asserts the limit (Л14.3). */
function runRustTest() {
  return new Promise((resolveRun) => {
    const child = spawn('node', ['scripts/run-with-disposable-home.mjs', 'cargo', 'test', '-p', 'mine', '--lib', '--features', 'tooling', '--locked',
      'storage::note_edit::tests::a_save_of_a_note_of_100_kb_answers_within_its_limit', '--', '--nocapture'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CARGO_TARGET_DIR: join(root, 'target/editing-perf'),
        CARGO_PROFILE_DEV_OPT_LEVEL: '3',
        CARGO_PROFILE_TEST_OPT_LEVEL: '3',
        MINE_SAVE_TIMING: 'assert',
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => {
      const line = /save_note_body, (\d+) B: median ([\d.]+)(µs|ms), p95 ([\d.]+)(µs|ms), limit [^,]+, asserted/.exec(output);
      const ms = (value, unit) => Number(value) / (unit === 'µs' ? 1000 : 1);
      resolveRun({
        passed: code === 0 && /1 passed/.test(output),
        bytes: line ? Number(line[1]) : null,
        medianMs: line ? round(ms(line[2], line[3])) : null,
        p95Ms: line ? round(ms(line[4], line[5])) : null,
        tail: output.split('\n').slice(-8).join('\n'),
      });
    });
  });
}

// ─── Judging ────────────────────────────────────────────────────────────────

const results = [];
function judge(name, value, limit, { set = null, place = null, measure = null, unit = 'ms' } = {}) {
  const known = KNOWN_EXCEEDANCES.find((exception) => exception.set === set && exception.places.includes(place) && exception.measure === measure);
  const holds = value <= limit;
  let status;
  if (known) status = holds ? (known.intermittent ? 'pass' : 'stale-exception') : value <= known.ceilingMs ? 'known-exceedance' : 'regression';
  else status = holds ? 'pass' : 'fail';
  results.push({ name, value, limit, unit, status, exception: known?.id ?? null });
  const word = { pass: 'PASS', fail: 'FAIL', 'known-exceedance': `KNOWN EXCEEDANCE ${known?.id}`, 'stale-exception': `STALE EXCEPTION ${known?.id}`, regression: `REGRESSION ${known?.id}` }[status];
  const detail = known && status !== 'pass' ? ` (${known.why}; ceiling ${known.ceilingMs} ms; waits for ${known.waitsFor})` : '';
  console.log(`${word} ${name}: ${value} ${unit} against ${limit} ${unit}${detail}`);
}

let browser;
let server;
const report = { started: new Date().toISOString(), limits: LIMITS, knownExceedances: KNOWN_EXCEEDANCES, sets: [] };
try {
  console.log(`editing-perf: building the page into ${buildFolder}`);
  report.build = await buildPage();
  console.log(`editing-perf: built in ${report.build.ms} ms; the editor's part ${report.build.editorChunk.file}: ${report.build.editorChunk.bytes} B, gzip ${report.build.editorChunk.gzip} B`);
  server = await startServer();
  browser = await chromium.launch({ headless: true });

  report.chunk = await measureChunk(browser, server.origin);
  judge(`loading the editor's part of the build, ${report.chunk.runs[0]?.files.length ?? 0} files of ${report.chunk.bytes} B (median of fresh pages)`, report.chunk.ms, LIMITS.chunkLoadMs);
  report.entry = await measureEntry(browser, server.origin);
  judge('entering editing on the fixture to the first frame (median)', report.entry.ms, LIMITS.entryMs);
  assert(report.entry.runs.every((run) => !run.raw), `the first frame of the editor shows no raw markup: ${JSON.stringify(report.entry.runs)}`);

  for (const set of sets) {
    console.log(`editing-perf: ${set.name}`);
    const measured = await measureSet(browser, server.origin, set);
    report.sets.push(measured);
    console.log(`  opened in ${measured.openMs} ms, parsed in ${measured.parsedMs} ms`);
    for (const typing of measured.typing) {
      judge(`${set.name}: typing in ${typing.place}, p95 (median ${typing.median}, max ${typing.max}, write's answer p95 ${typing.answerP95})`, typing.p95, LIMITS.typingP95Ms, { set: set.name, place: typing.place, measure: 'typingP95Ms' });
    }
    if (measured.scroll) {
      const longest = Math.max(0, ...measured.scroll.longFrames.map((frame) => frame.ms));
      const again = measured.scroll.previous ? `, the better of two passes, the other's longest ${Math.max(0, ...measured.scroll.previous.longFrames.map((frame) => frame.ms))} ms` : '';
      judge(`${set.name}: the longest frame of the measured scroll pass (${measured.scroll.frames} frames, ${measured.scroll.longFrames.length} over the limit, ${measured.warmLongFrames} on the first pass${again})`, longest, LIMITS.longFrameMs, { set: set.name, measure: 'longFrameMs' });
    }
    assert(measured.accepted, `${set.name}: every write went over its base`);
    assert.deepEqual(measured.errors, [], `${set.name}: no page errors`);
  }

  const proseHeaps = ['prose-1mb', 'prose-10mb'].map((name) => report.sets.find((set) => set.name === name)?.heap);
  if (proseHeaps.every(Boolean)) {
    const [small, large] = proseHeaps;
    // A copy of the text is two bytes a sign: the prose is not Latin-1.
    const copies = (large.editorBytes - small.editorBytes) / ((large.documentChars - small.documentChars) * 2);
    report.memory = { small, large, copies: round(copies) };
    judge(`memory: what the open card with the editor adds from 1 MB to 10 MB of prose, in copies of the text added (${Math.round(small.editorBytes / 1e6)} MB and ${Math.round(large.editorBytes / 1e6)} MB)`, round(copies), LIMITS.memoryCopies, { unit: 'copies' });
  }

  // Л14.4: the size from which typing does not hold its limit, among prose
  // of whole megabytes.
  if (!only) {
    const sizes = [];
    for (const megabytes of [1, ...THRESHOLD_MEGABYTES, 10]) {
      const name = `prose-${megabytes}mb`;
      let p95 = report.sets.find((set) => set.name === name)?.typing[0]?.p95;
      if (p95 === undefined) {
        console.log(`editing-perf: ${name}, typing at its top`);
        const measured = await measureSet(browser, server.origin, { name, places: [TOP], scroll: false });
        report.sets.push(measured);
        p95 = measured.typing[0].p95;
        console.log(`  typing p95 ${p95} ms (median ${measured.typing[0].median})`);
      }
      sizes.push({ megabytes, p95 });
    }
    const first = sizes.find((size) => size.p95 > LIMITS.typingP95Ms);
    report.threshold = { sizes, megabytes: first?.megabytes ?? null };
    console.log(`editing-perf: Л14.4 size threshold: ${first ? `${first.megabytes} MB, the smallest measured size where typing does not hold ${LIMITS.typingP95Ms} ms` : 'none up to 10 MB'} (${sizes.map((size) => `${size.megabytes} MB ${size.p95} ms`).join(', ')})`);
  }

  if (args.get('skip-rust') !== 'true') {
    console.log('editing-perf: the Rust test of save_note_body in an optimised build');
    report.rust = await runRustTest();
    assert(report.rust.passed, `the Rust test of save_note_body passes:\n${report.rust.tail}`);
    judge(`save_note_body on a note of ${report.rust.bytes} B, p95 (median ${report.rust.medianMs})`, report.rust.p95Ms, 50);
  }
} finally {
  await browser?.close();
  await server?.close();
  rmSync(buildFolder, { recursive: true, force: true });
  report.results = results;
  report.finished = new Date().toISOString();
  writeFileSync(join(runFolder, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`editing-perf: report ${join(runFolder, 'report.json')}`);
}

const failed = results.filter((result) => !['pass', 'known-exceedance'].includes(result.status));
const known = results.filter((result) => result.status === 'known-exceedance');
console.log(`editing-perf: ${results.length - failed.length - known.length} held, ${known.length} known exceedances, ${failed.length} failed`);
if (failed.length > 0) process.exitCode = 1;
