// The tooltip that glides to its neighbour in headless WebKit, the engine of
// Mine's window (SPEC_MOTION_LEVELS.md, М3; user's decision of 15.11.2026):
// real layout, real frames and a real pointer, which the jsdom tests cannot
// see. A stand page holds the real `TooltipProvider` and `Button`s: one
// group like the image preview's island (Zoom out, a label, Zoom in, a
// separator, Copy media), and one button in a container of its own. Every
// frame records each tooltip on the page as it was painted: whether it
// shows, its frame's box (the frame in pieces while it glides), its opacity
// and its text. It checks, at the three levels alike (Р1): the first
// tooltip after its delay as before; on to the neighbour, a tooltip in
// every frame, its frame going monotonically from the old button's place
// to the new one's on the stack's spring, the new text and width at the
// end; a third button mid-way, from where the frame stands without a jump;
// out of the group, gone as before; another group's button, its own
// tooltip at its own place; a key's focus, at once. Starts and stops its
// own Vite.
import assert from "node:assert/strict";
import { webkit } from "playwright";
import { COLD_START_MS, startAuditVite } from "./audit-vite.mjs";

const VIEWPORT = { width: 900, height: 500 };
/** The button's tooltip delay (button.tsx). */
const DELAY_MS = 500;
/** SPRING_RESPONSE_S (channelIcon.ts): the stack's spring, the preview
 *  window's, the glide's. */
const SPRING_RESPONSE_S = 0.3;
/** springSettleMs(SPRING_RESPONSE_S): from rest to rest. */
const SETTLE_MS = 441;
/** --motion-enter, --motion-exit: the texts' fades, Отклик's. */
const ENTER_MS = 150;
const EXIT_MS = 100;
/** --motion-enter: a tooltip's own coming and going (М3). */
const SURFACE_MS = 150;
/** A frame at 60 Hz. */
const FRAME_MS = 1000 / 60;
/** How far a box may lie from where it should be, px. */
const BOX_SLACK_PX = 0.75;
/** How far the path's share may lie from the spring's at a frame's time:
 *  a frame's place is written at the start of the frame, its time read
 *  between frames, a few milliseconds apart. */
const SHARE_SLACK = 0.03;

const entry = "/tooltip-glide-audit-entry.js";

const STAND_PAGE = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {Button} from '/src/components/ui/button.tsx';
  import {TooltipProvider} from '/src/components/ui/tooltip.tsx';
  import {installMotionLevel} from '/src/lib/motion.ts';
  import {installMotionInput} from '/src/lib/motionInput.ts';
  import '/src/styles/global.css';
  installMotionLevel();
  installMotionInput();
  const h=React.createElement;
  const icon=(label,id)=>h(Button,{type:'button',variant:'ghost',size:'icon','aria-label':label,id},'•');
  function Stand(){
    return h(TooltipProvider,null,
      h('div',{style:{padding:80,display:'flex',gap:160,alignItems:'flex-start'}},
        h('div',{id:'group',className:'flex h-8 items-center gap-1 rounded-1 border border-border bg-popover px-1'},
          icon('Zoom out','zoom-out'),
          h('span',{id:'label',className:'min-w-[5ch] text-center font-mono text-sm'},'100%'),
          icon('Zoom in','zoom-in'),
          h('div',{className:'h-6 w-px bg-border'}),
          icon('Copy media to the clipboard','copy')),
        h('div',{id:'other',className:'flex h-8 items-center'},icon('Close','close'))));
  }
  createRoot(document.getElementById('root')).render(h(Stand));
`;

/** Records every painted frame from now on: each tooltip on the page,
 *  whether it shows, the box its frame stands in, its opacity and text. */
function installRecorder() {
  window.__frames = [];
  window.__recording = false;
  const boxOf = (element) => {
    const box = element.getBoundingClientRect();
    return { x: box.left, y: box.top, width: box.width, height: box.height };
  };
  // A leaving that reached 0 is over: Radix restores the fill mode a task
  // after the animation's end and React removes the element a little later,
  // so a read in between sees the base opacity of an element on its way out
  // of the page, as it did before the glide.
  const ended = new WeakSet();
  const read = () => Array.from(document.querySelectorAll('[data-slot="tooltip-content"]'), (content) => {
    const style = getComputedStyle(content);
    const closed = content.getAttribute("data-state") === "closed";
    if (closed && Number(style.opacity) <= 0.01) ended.add(content);
    const wrapper = content.parentElement;
    const placed = wrapper !== null && !wrapper.style.transform.includes("-200%");
    const gliding = content.hasAttribute("data-tooltip-gliding");
    const frame = gliding ? content.querySelector('[data-tooltip-glide-piece="shadow"]') : content;
    const text = content.querySelector("[data-tooltip-text]");
    return {
      shows: placed && !(closed && ended.has(content)) && style.visibility !== "hidden" && Number(style.opacity) > 0.01,
      gliding,
      opacity: Number(style.opacity),
      box: boxOf(frame),
      laid: boxOf(content),
      text: text?.textContent ?? "",
      textOpacity: text ? Number(getComputedStyle(text).opacity) : 1,
      outgoing: content.querySelectorAll("[data-tooltip-glide-outgoing]").length,
      side: content.getAttribute("data-side"),
      key: content.hasAttribute("data-motion-key"),
      state: content.getAttribute("data-state"),
    };
  });
  const loop = (frameTime) => {
    if (window.__recording) {
      // What the frame showed: read once every frame callback has written.
      setTimeout(() => window.__frames.push({ at: frameTime, tips: read() }), 0);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.__read = read;
}

/** The share of the path a critically damped spring of `responseS` has gone
 *  at `ms`. */
function springShare(ms) {
  const omega = (2 * Math.PI) / SPRING_RESPONSE_S;
  const t = Math.max(0, ms) / 1000;
  return 1 - (1 + omega * t) * Math.exp(-omega * t);
}

const centre = (box) => box.x + box.width / 2;

function near(actual, expected, message, within) {
  assert(Math.abs(actual - expected) <= within, `${message}: ${actual} against ${expected}`);
}

const passed = (message) => console.log(`PASS: ${message}`);

const vite = await startAuditVite([{
  name: "tooltip-glide-audit",
  resolveId(id) { if (id === entry) return `\0${entry}`; return undefined; },
  load(id) { if (id === `\0${entry}`) return STAND_PAGE; return undefined; },
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (!req.url.startsWith("/__tooltip-glide-audit")) return next();
      res.setHeader("Content-Type", "text/html");
      res.end(await server.transformIndexHtml(req.url, `<html><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`));
      return undefined;
    });
  },
}]);

let browser;
try {
  browser = await webkit.launch({ headless: true });

  const fresh = async (level) => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((stored) => window.localStorage.setItem("mine.motion", stored), level);
    await page.addInitScript(installRecorder);
    await page.goto(new URL("/__tooltip-glide-audit", vite.origin).href, { timeout: COLD_START_MS });
    await page.waitForSelector("#zoom-out", { timeout: COLD_START_MS });
    await page.waitForTimeout(300);
    return { page, errors };
  };

  const middleOf = async (page, selector) => {
    const box = await page.locator(selector).boundingBox();
    assert(box, `${selector} on the page`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
  };
  const record = (page) => page.evaluate(() => {
    window.__frames = [];
    window.__recording = true;
  });
  const recorded = (page) => page.evaluate(() => new Promise((resolve) => {
    setTimeout(() => {
      window.__recording = false;
      resolve(window.__frames);
    }, 50);
  }));
  const shownTips = (frame) => frame.tips.filter((tip) => tip.shows);
  /** The tooltip a frame shows, the only one. */
  const theTip = (frame, name) => {
    const shown = shownTips(frame);
    assert.equal(shown.length, 1, `${name}: one tooltip shows at ${frame.at.toFixed(1)} ms, not ${shown.length}: ${JSON.stringify(shown.map(({ text, opacity, gliding, box, state }) => ({ text, opacity, gliding, x: Math.round(box.x), state })))}`);
    return shown[0];
  };

  /** Rests on `from` past the delay, so its tooltip is up. */
  const restOn = async (page, selector) => {
    const { x, y } = await middleOf(page, selector);
    await page.mouse.move(x, y, { steps: 4 });
    await page.waitForTimeout(DELAY_MS + SURFACE_MS + 150);
    const tips = await page.evaluate(() => window.__read());
    return tips.filter((tip) => tip.shows);
  };

  /** The pointer from where it is to `selector`'s middle in `steps` moves,
   *  then on a little over it, as a hand goes on moving: Radix opens a
   *  tooltip on a move over its button, and a move inside the old
   *  tooltip's grace area towards its content opens nothing. */
  const glideTo = async (page, selector, steps) => {
    const { x, y } = await middleOf(page, selector);
    await page.mouse.move(x, y, { steps });
    await page.mouse.move(x + 1, y, { steps: 1 });
    await page.mouse.move(x + 1, y + 1, { steps: 1 });
  };

  /** A glide recorded from the old button to the new: the checks every
   *  level shares. Returns its frames from the first moving one. */
  const checkGlide = (name, frames, from, to, text) => {
    const tips = frames.map((frame) => theTip(frame, name));
    // A tooltip in every frame, at full opacity in the frames it glides.
    const gliding = tips.map((tip, index) => ({ tip, frame: frames[index] })).filter(({ tip }) => tip.gliding);
    assert(gliding.length >= 6, `${name}: it glides over frames (${gliding.length})`);
    for (const { tip } of gliding) near(tip.opacity, 1, `${name}: the frame stays whole on its way`, 0.02);
    // From the old button's tooltip to the new one's, monotonically.
    const start = centre(from);
    const end = centre(to);
    const direction = Math.sign(end - start);
    let previous = start;
    for (const { tip } of gliding) {
      const now = centre(tip.box);
      assert((now - previous) * direction >= -0.05, `${name}: the frame turned back from ${previous} to ${now}`);
      previous = now;
    }
    // The first frame on the way is within one frame's step of the old place.
    const firstShare = (centre(gliding[0].tip.box) - start) / (end - start);
    assert(firstShare <= springShare(2 * FRAME_MS) + SHARE_SLACK, `${name}: the first frame jumped to ${firstShare}`);
    // On the stack's spring: the share of the path at each frame's time,
    // the place's and the width's alike. The motion starts at the opening,
    // up to a frame before the first frame it shows in; that start is
    // fitted, every frame then lies on the one curve.
    const widthChange = to.width - from.width;
    const samples = gliding.flatMap(({ tip, frame }) => [
      { at: frame.at, share: (centre(tip.box) - start) / (end - start), what: "the place" },
      ...(Math.abs(widthChange) >= 4 ? [{ at: frame.at, share: (tip.box.width - from.width) / widthChange, what: "the width" }] : []),
    ]);
    const worstFrom = (t0) => Math.max(...samples.map(({ at, share }) => Math.abs(share - springShare(at - t0))));
    let t0 = gliding[0].frame.at;
    for (let lead = 0; lead <= 2 * FRAME_MS; lead += 0.25) {
      if (worstFrom(gliding[0].frame.at - lead) < worstFrom(t0)) t0 = gliding[0].frame.at - lead;
    }
    const worst = worstFrom(t0);
    for (const { at, share, what } of samples) {
      assert(Math.abs(share - springShare(at - t0)) <= SHARE_SLACK,
        `${name}: ${what} ${share.toFixed(3)} of the way at ${(at - t0).toFixed(1)} ms, the spring's ${springShare(at - t0).toFixed(3)}`);
    }
    for (const { tip } of gliding) near(tip.box.y, to.y, `${name}: one line, the frame's top`, BOX_SLACK_PX);
    // The width goes from the old to the new the same way, the corners whole.
    const last = tips.at(-1);
    assert(!last.gliding, `${name}: the glide comes to rest`);
    near(last.box.x, to.x, `${name}: at rest on the new place, x`, BOX_SLACK_PX);
    near(last.box.y, to.y, `${name}: at rest on the new place, y`, BOX_SLACK_PX);
    near(last.box.width, to.width, `${name}: at rest in the new width`, BOX_SLACK_PX);
    assert.equal(last.text, text, `${name}: the new text`);
    near(last.opacity, 1, `${name}: the tooltip whole at rest`, 1e-3);
    const restIndex = tips.findIndex((tip, index) => index > 0 && !tip.gliding && tips[index - 1].gliding);
    assert(restIndex > 0, `${name}: a frame the glide comes to rest in`);
    const settledAt = frames[restIndex].at - t0;
    assert(settledAt <= SETTLE_MS + 4 * FRAME_MS, `${name}: at rest after ${settledAt} ms`);
    // The new text came in on Отклик's enter, the old went on its exit.
    const firstGliding = gliding[0].tip;
    assert(firstGliding.outgoing >= 1, `${name}: the old text rides over the new frame`);
    const textIn = gliding.find(({ tip }) => tip.textOpacity >= 0.999);
    assert(textIn && textIn.frame.at - t0 <= ENTER_MS + 2 * FRAME_MS, `${name}: the new text in within ${ENTER_MS} ms`);
    const textOut = gliding.find(({ tip }) => tip.outgoing === 0 || tip.textOpacity >= 0.999);
    assert(textOut, `${name}: the old text out`);
    return { gliding, t0, worst, settledAt };
  };

  for (const level of ["full", "minimal", "off"]) {
    const { page, errors } = await fresh(level);

    // ── The first tooltip comes as before, after its delay ──
    {
      const shown = await restOn(page, "#zoom-out");
      assert.equal(shown.length, 1, `${level}: the first tooltip is up`);
      assert.equal(shown[0].text, "Zoom out");
      assert(!shown[0].gliding);
      passed(`${level}: the first tooltip comes after its delay, as before`);
    }

    // ── On to the neighbour across the label: it glides ──
    let zoomIn;
    {
      const from = (await page.evaluate(() => window.__read())).find((tip) => tip.shows).box;
      await record(page);
      await glideTo(page, "#zoom-in", 6);
      await page.waitForTimeout(SETTLE_MS + 200);
      const frames = await recorded(page);
      const moving = frames.findIndex((frame) => shownTips(frame).some((tip) => tip.text === "Zoom in"));
      assert(moving > 0, `${level}: the neighbour's tooltip came`);
      // Every frame from the start shows exactly one tooltip.
      for (const frame of frames) theTip(frame, `${level}, Zoom out to Zoom in`);
      zoomIn = (await page.evaluate(() => window.__read())).find((tip) => tip.shows).laid;
      const { gliding, worst, settledAt } = checkGlide(`${level}, Zoom out to Zoom in`, frames.slice(moving), from, zoomIn, "Zoom in");
      const widest = Math.max(...gliding.map(({ tip }) => tip.box.width));
      const narrowest = Math.min(...gliding.map(({ tip }) => tip.box.width));
      assert(widest <= Math.max(from.width, zoomIn.width) + BOX_SLACK_PX && narrowest >= Math.min(from.width, zoomIn.width) - BOX_SLACK_PX,
        `${level}: the width stays between the two`);
      passed(`${level}: on to the neighbour across a label the tooltip glides on the spring: ${gliding.length} frames, at rest after ${settledAt.toFixed(0)} ms, at most ${worst.toFixed(3)} of the way off the spring, ${from.width.toFixed(1)} to ${zoomIn.width.toFixed(1)} px wide, ${Math.abs(centre(zoomIn) - centre(from)).toFixed(1)} px across`);
    }

    // ── A third button mid-way: from where the frame stands ──
    {
      await record(page);
      await glideTo(page, "#copy", 3);
      await page.waitForTimeout(80);
      await glideTo(page, "#zoom-out", 8);
      await page.waitForTimeout(SETTLE_MS + 250);
      const frames = await recorded(page);
      const tips = frames.map((frame) => theTip(frame, `${level}, a third button`));
      let biggest = 0;
      for (let index = 1; index < tips.length; index += 1) {
        biggest = Math.max(biggest, Math.abs(centre(tips[index].box) - centre(tips[index - 1].box)));
      }
      const sawCopy = tips.some((tip) => tip.text === "Copy media to the clipboard");
      assert(sawCopy, `${level}: the third button's tooltip took over`);
      const last = tips.at(-1);
      assert.equal(last.text, "Zoom out", `${level}: on the last button`);
      assert(!last.gliding, `${level}: at rest`);
      // No frame-to-frame jump larger than the spring's fastest step over the
      // longest way, from Zoom in to Copy and back to Zoom out.
      const way = Math.abs(centre(last.box) - centre(zoomIn)) + 200;
      // A critically damped spring from rest is fastest at t = 1/ω, at ω/e
      // of its way per second.
      const omega = (2 * Math.PI) / SPRING_RESPONSE_S;
      const fastest = ((way * omega) / Math.E) * (FRAME_MS / 1000) * 1.5;
      assert(biggest <= fastest, `${level}: a jump of ${biggest} px between frames (the spring's fastest ${fastest.toFixed(1)})`);
      passed(`${level}: turned to a third button and back mid-way, the frame goes on from where it stands, at most ${biggest.toFixed(1)} px a frame`);
    }

    // ── Out of the group: gone as before ──
    {
      await record(page);
      const { box } = await middleOf(page, "#group");
      await page.mouse.move(box.x + 40, box.y + box.height + 120, { steps: 3 });
      await page.waitForTimeout(SURFACE_MS + 200);
      const frames = await recorded(page);
      const gone = frames.findIndex((frame) => shownTips(frame).length === 0);
      assert(gone > 0, `${level}: the tooltip left`);
      assert(frames.slice(gone).every((frame) => shownTips(frame).length === 0), `${level}: and stays gone`);
      const shownFor = frames[gone].at - frames[0].at;
      assert(shownFor <= SURFACE_MS + 6 * FRAME_MS, `${level}: gone within its leaving, ${shownFor} ms`);
      passed(`${level}: out of the group the tooltip goes as before, in ${shownFor.toFixed(0)} ms`);
    }

    // ── Another group's button: its own tooltip at its own place ──
    {
      await restOn(page, "#copy");
      await record(page);
      await glideTo(page, "#close", 12);
      await page.waitForTimeout(SURFACE_MS + 250);
      const frames = await recorded(page);
      const closeTips = frames.flatMap((frame) => frame.tips.filter((tip) => tip.shows && tip.text === "Close"));
      assert(closeTips.length > 0, `${level}: the other group's tooltip came`);
      assert(closeTips.every((tip) => !tip.gliding), `${level}: it does not glide`);
      const first = closeTips[0];
      near(centre(first.box), centre(first.laid), `${level}: it comes at its own place`, first.laid.width * 0.05 + BOX_SLACK_PX);
      passed(`${level}: another group's button brings its own tooltip at its own place`);
    }

    // ── Out of the window in one move: gone as from any leaving ──
    // WebKit sends the button and the elements up to the root a leave with
    // no related target and no move (SPEC_MOTION_LEVELS.md, «Подсказка
    // уходит, когда курсор покинул окно»); before 15.11.2026 the tooltip
    // stayed.
    const leavesTheWindow = async (name, prepare) => {
      await prepare();
      await record(page);
      const { y } = await middleOf(page, "#zoom-in");
      await page.mouse.move(-40, y, { steps: 1 });
      await page.waitForTimeout(SURFACE_MS + 250);
      const frames = await recorded(page);
      const gone = frames.findIndex((frame) => shownTips(frame).length === 0);
      assert(gone >= 0, `${level}, ${name}: the tooltip left`);
      assert(frames.slice(gone).every((frame) => shownTips(frame).length === 0), `${level}, ${name}: and stays gone`);
      const shownFor = frames[gone].at - frames[0].at;
      assert(shownFor <= SURFACE_MS + 6 * FRAME_MS, `${level}, ${name}: gone within its leaving, ${shownFor} ms`);
      for (const frame of frames.slice(0, gone)) assert(shownTips(frame).length <= 1, `${level}, ${name}: one tooltip at most`);
      return shownFor;
    };
    {
      const atRest = await leavesTheWindow("at rest", () => restOn(page, "#zoom-in"));
      const onItsWay = await leavesTheWindow("on its way", async () => {
        await restOn(page, "#zoom-out");
        await glideTo(page, "#zoom-in", 6);
        await page.waitForTimeout(60);
        const tips = await page.evaluate(() => window.__read());
        assert(tips.some((tip) => tip.shows && tip.gliding), `${level}: gliding when the pointer leaves`);
      });
      passed(`${level}: out of the window in one move the tooltip goes as from any leaving, at rest in ${atRest.toFixed(0)} ms, on its way in ${onItsWay.toFixed(0)} ms`);
    }
    {
      await page.waitForTimeout(400);
      await page.keyboard.press("Tab");
      await page.waitForTimeout(SURFACE_MS + 100);
      const before = (await page.evaluate(() => window.__read())).filter((tip) => tip.shows);
      assert.equal(before.length, 1, `${level}: Tab brought a tooltip`);
      await page.mouse.move(-40, 16, { steps: 1 });
      await page.mouse.move(-60, 16, { steps: 1 });
      await page.waitForTimeout(SURFACE_MS + 200);
      const after = (await page.evaluate(() => window.__read())).filter((tip) => tip.shows);
      assert.deepEqual(after.map((tip) => tip.text), before.map((tip) => tip.text), `${level}: the focus's tooltip stays`);
      await page.evaluate(() => document.activeElement?.blur());
      await page.waitForTimeout(SURFACE_MS + 100);
      passed(`${level}: a tooltip the keyboard's focus opened stays when the pointer leaves the window`);
    }

    // ── A key's focus: at once, no glide ──
    {
      await page.mouse.move(5, VIEWPORT.height - 5, { steps: 2 });
      await page.waitForTimeout(400);
      await page.focus("#zoom-out");
      await page.waitForTimeout(SURFACE_MS + 100);
      await record(page);
      await page.keyboard.press("Tab");
      await page.waitForTimeout(SETTLE_MS);
      const frames = await recorded(page);
      const tips = frames.flatMap((frame) => frame.tips.filter((tip) => tip.shows));
      const zoomInTips = tips.filter((tip) => tip.text === "Zoom in");
      assert(zoomInTips.length > 0, `${level}: Tab brought the next button's tooltip`);
      assert(tips.every((tip) => !tip.gliding), `${level}: a key's tooltip never glides`);
      assert(zoomInTips.every((tip) => tip.key), `${level}: it carries the key's mark, at once`);
      near(zoomInTips[0].opacity, 1, `${level}: whole in its first frame`, 1e-3);
      passed(`${level}: the keyboard's focus stands its tooltip at once, no glide`);
    }

    assert.deepEqual(errors, [], `${level}: page errors`);
    await page.close();
  }
} finally {
  await browser?.close();
  await vite.close();
}
