// The tooltips of a row of buttons in headless WebKit, the engine of Mine's
// window (SPEC_MOTION_LEVELS.md, М3; user's decision of 15.11.2026, after the
// motion guide): real layout, real animations, real frames and a real
// pointer, which the jsdom tests cannot see. A stand page holds the real
// `TooltipProvider` and `Button`s: one row like the image preview's island
// (Zoom out, a label, Zoom in, a separator, Copy media), and one button in a
// container of its own. Every painted frame records each tooltip on the page:
// whether it shows, its surface's box, its opacity, its text and the box of
// that text. It checks, at the three levels alike (Р1): in every frame each
// shown tooltip's text lies inside its surface, and never two show; the first
// tooltip after its delay with its appearance; the next one, in this row or
// another, in its place and whole in its first frame, the one before gone in
// that same frame; a tooltip the pointer leaves for nothing goes with its
// leaving; out of the window in one move, gone as from any leaving; a key's
// focus, at once, staying when the pointer leaves. Starts and stops its own
// Vite.
import assert from "node:assert/strict";
import { webkit } from "playwright";
import { COLD_START_MS, startAuditVite } from "./audit-vite.mjs";

const VIEWPORT = { width: 900, height: 500 };
/** The button's tooltip delay (button.tsx). */
const DELAY_MS = 500;
/** --motion-enter: a tooltip's appearance and its leaving (М3). */
const SURFACE_MS = 150;
/** A frame at 60 Hz. */
const FRAME_MS = 1000 / 60;
/** How far a box may lie from where it should be, px. */
const BOX_SLACK_PX = 0.75;

const entry = "/tooltip-motion-audit-entry.js";

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
  const chrome=(label,id)=>h(Button,{type:'button',variant:'chrome',size:'chrome-icon','aria-label':label,id},'•');
  function Stand(){
    return h(TooltipProvider,null,
      h('div',{style:{padding:80,display:'flex',gap:160,alignItems:'flex-start'}},
        h('div',{id:'group',className:'flex h-8 items-center gap-1 rounded-1 border border-border bg-popover px-1'},
          icon('Zoom out','zoom-out'),
          h('span',{id:'label',className:'min-w-[5ch] text-center font-mono text-sm'},'100%'),
          icon('Zoom in','zoom-in'),
          h('div',{className:'h-6 w-px bg-border'}),
          icon('Copy media to the clipboard','copy')),
        h('div',{id:'other',className:'flex h-8 items-center'},icon('Close','close'))),
      // A top row of 40 px with its line, the bottom bar's 30 px row, and a
      // top row at the window's bottom, where Radix flips the tooltip up.
      h('div',{className:'chrome-row flex items-center gap-1 px-2','data-chrome-separator':'bottom',style:{position:'absolute',top:240,left:80}},chrome('Display options','row40')),
      h('div',{className:'chrome-row flex items-center gap-1 px-2',style:{position:'absolute',top:320,left:80}},chrome('Hide Sidebar','row30')),
      h('div',{className:'chrome-row flex items-center gap-1 px-2','data-chrome-separator':'bottom',style:{position:'fixed',bottom:0,left:400}},chrome('Mine settings','flipped')));
  }
  createRoot(document.getElementById('root')).render(h(Stand));
`;

/** Records every painted frame from now on: each tooltip on the page,
 *  whether it shows, its surface's box, its opacity, its text and the box of
 *  that text as painted. */
function installRecorder() {
  window.__frames = [];
  window.__recording = false;
  const boxOf = (rect) => ({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
  // A leaving that reached 0 is over: Radix restores the fill mode a task
  // after the animation's end and React removes the element a little later,
  // so a read in between sees the base opacity of an element on its way out.
  const ended = new WeakSet();
  const read = () => Array.from(document.querySelectorAll('[data-slot="tooltip-content"]'), (content) => {
    const style = getComputedStyle(content);
    const closed = content.getAttribute("data-state") === "closed";
    if (closed && Number(style.opacity) <= 0.01) ended.add(content);
    const wrapper = content.parentElement;
    const placed = wrapper !== null && !wrapper.style.transform.includes("-200%");
    // The tooltip's own text, before the copy Radix keeps for assistive
    // technology.
    const text = document.createRange();
    text.selectNodeContents(content);
    const hidden = content.querySelector('[role="tooltip"]');
    if (hidden) text.setEndBefore(hidden);
    return {
      shows: placed && !(closed && ended.has(content)) && style.visibility !== "hidden" && Number(style.opacity) > 0.01,
      opacity: Number(style.opacity),
      state: content.getAttribute("data-state"),
      box: boxOf(content.getBoundingClientRect()),
      textBox: boxOf(text.getBoundingClientRect()),
      text: text.toString(),
      key: content.hasAttribute("data-motion-key"),
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

function near(actual, expected, message, within) {
  assert(Math.abs(actual - expected) <= within, `${message}: ${actual} against ${expected}`);
}

const passed = (message) => console.log(`PASS: ${message}`);

const vite = await startAuditVite([{
  name: "tooltip-motion-audit",
  resolveId(id) { if (id === entry) return `\0${entry}`; return undefined; },
  load(id) { if (id === `\0${entry}`) return STAND_PAGE; return undefined; },
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (!req.url.startsWith("/__tooltip-motion-audit")) return next();
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
    // Double density, as a Mac's screen: Radix rounds a layer's place to
    // whole device pixels, and a 24 px plate centred in a 39 px row stands on
    // a half pixel.
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((stored) => window.localStorage.setItem("mine.motion", stored), level);
    await page.addInitScript(installRecorder);
    await page.goto(new URL("/__tooltip-motion-audit", vite.origin).href, { timeout: COLD_START_MS });
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

  /** Every frame: never two tooltips, and each one's text inside its surface. */
  const checkFrames = (name, frames) => {
    for (const frame of frames) {
      const shown = shownTips(frame);
      assert(shown.length <= 1, `${name}: ${shown.length} tooltips at ${frame.at.toFixed(1)} ms: ${shown.map((tip) => tip.text).join(", ")}`);
      for (const tip of shown) {
        const { box, textBox } = tip;
        const inside = textBox.x >= box.x - 0.5
          && textBox.y >= box.y - 0.5
          && textBox.x + textBox.width <= box.x + box.width + 0.5
          && textBox.y + textBox.height <= box.y + box.height + 0.5;
        assert(inside, `${name}: "${tip.text}" outside its surface at ${frame.at.toFixed(1)} ms: ${JSON.stringify({ box, textBox })}`);
      }
    }
  };

  /** The pointer from where it is to `selector`'s middle in `steps` moves,
   *  then on a little over it, as a hand goes on moving: Radix opens a
   *  tooltip on a move over its button, and a move inside the old
   *  tooltip's grace area towards its content opens nothing. */
  const moveTo = async (page, selector, steps) => {
    const { x, y } = await middleOf(page, selector);
    await page.mouse.move(x, y, { steps });
    await page.mouse.move(x + 1, y, { steps: 1 });
    await page.mouse.move(x + 1, y + 1, { steps: 1 });
  };

  /** Rests on `selector` past the delay, so its tooltip is up and whole. */
  const restOn = async (page, selector) => {
    await moveTo(page, selector, 4);
    await page.waitForTimeout(DELAY_MS + SURFACE_MS + 150);
    return (await page.evaluate(() => window.__read())).filter((tip) => tip.shows);
  };

  /** Off the buttons, until no tooltip is left and the skip of the delay
   *  is over. */
  const away = async (page) => {
    await page.mouse.move(40, VIEWPORT.height - 20, { steps: 3 });
    await page.waitForTimeout(SURFACE_MS + 400);
  };

  /** A next tooltip: from the shown one to `selector`'s. Its first frame
   *  shows it whole at its place, the one before gone in that frame. */
  const checkNext = async (page, level, name, selector, text) => {
    await record(page);
    await moveTo(page, selector, 6);
    await page.waitForTimeout(SURFACE_MS + 150);
    const frames = await recorded(page);
    checkFrames(`${level}, ${name}`, frames);
    const first = frames.findIndex((frame) => shownTips(frame).some((tip) => tip.text === text));
    assert(first > 0, `${level}, ${name}: the next tooltip came`);
    const firstTip = shownTips(frames[first])[0];
    const settled = (await page.evaluate(() => window.__read())).find((tip) => tip.shows);
    assert.equal(settled?.text, text, `${level}, ${name}: the next one stays`);
    near(firstTip.opacity, 1, `${level}, ${name}: whole in its first frame`, 1e-3);
    for (const key of ["x", "y", "width", "height"]) {
      near(firstTip.box[key], settled.box[key], `${level}, ${name}: at its place in its first frame, ${key}`, BOX_SLACK_PX);
    }
    // From the next one's opening to its first frame, the one before still
    // shows if it was showing: no frame without a tooltip at the change. Over
    // the label or the separator with no tooltip of its own, the one before
    // may have gone with its leaving before the next one opened.
    const opened = frames.findIndex((frame) => frame.tips.some((tip) => tip.text === text && tip.state !== "closed"));
    const before = frames[opened - 1];
    if (before && shownTips(before).length === 1) {
      for (const frame of frames.slice(opened, first)) {
        assert.equal(shownTips(frame).length, 1, `${level}, ${name}: a frame with no tooltip at ${frame.at.toFixed(1)} ms while the next one was placed`);
      }
    }
    return { frames: frames.length, handedOver: Boolean(before && shownTips(before).length === 1), placing: first - opened };
  };

  for (const level of ["full", "minimal", "off"]) {
    const { page, errors } = await fresh(level);

    // ── The first tooltip: after its delay, with its appearance ──
    {
      await record(page);
      const moved = await page.evaluate(() => performance.now());
      await moveTo(page, "#zoom-out", 4);
      await page.waitForTimeout(DELAY_MS + SURFACE_MS + 150);
      const frames = await recorded(page);
      checkFrames(`${level}, the first tooltip`, frames);
      const first = frames.findIndex((frame) => shownTips(frame).length > 0);
      assert(first >= 0, `${level}: the first tooltip came`);
      assert(frames[first].at - moved >= DELAY_MS - 2 * FRAME_MS, `${level}: after its delay, at ${(frames[first].at - moved).toFixed(0)} ms`);
      const opacities = frames.slice(first).map((frame) => shownTips(frame)[0]?.opacity ?? 0);
      assert(opacities[0] < 0.9, `${level}: it appears, its first frame at ${opacities[0]}`);
      const whole = opacities.findIndex((opacity) => opacity >= 0.999);
      assert(whole > 0 && whole * FRAME_MS <= SURFACE_MS + 3 * FRAME_MS, `${level}: whole after ${whole} frames`);
      passed(`${level}: the first tooltip comes after ${(frames[first].at - moved).toFixed(0)} ms with its appearance, whole after ${whole} frames`);
    }

    // ── The next one across the label, then the neighbours, then another row ──
    {
      const runs = [
        await checkNext(page, level, "Zoom out to Zoom in across the label", "#zoom-in", "Zoom in"),
        await checkNext(page, level, "Zoom in to Copy across the separator", "#copy", "Copy media to the clipboard"),
        await checkNext(page, level, "Copy to Close in another row", "#close", "Close"),
      ];
      const handed = runs.filter((run) => run.handedOver).length;
      passed(`${level}: the next tooltip, in the row or another, stands whole at its place in its first frame, never two; handed over from a shown one ${handed} of 3 times with no empty frame, placed in at most ${Math.max(...runs.map((run) => run.placing))} frames`);
    }

    // ── Off the buttons: the tooltip goes with its leaving ──
    {
      await restOn(page, "#zoom-in");
      await record(page);
      await page.mouse.move(40, VIEWPORT.height - 20, { steps: 3 });
      await page.waitForTimeout(SURFACE_MS + 200);
      const frames = await recorded(page);
      checkFrames(`${level}, off the buttons`, frames);
      const gone = frames.findIndex((frame) => shownTips(frame).length === 0);
      assert(gone > 1, `${level}: the tooltip left with its leaving`);
      const fading = frames.slice(0, gone).map((frame) => shownTips(frame)[0].opacity);
      assert(fading.some((opacity) => opacity < 0.9 && opacity > 0.01), `${level}: its leaving shows: ${fading.map((value) => value.toFixed(2)).join(" ")}`);
      const shownFor = frames[gone].at - frames[0].at;
      assert(shownFor <= SURFACE_MS + 6 * FRAME_MS, `${level}: gone within its leaving, ${shownFor} ms`);
      assert(frames.slice(gone).every((frame) => shownTips(frame).length === 0), `${level}: and stays gone`);
      passed(`${level}: a tooltip the pointer leaves for nothing goes with its leaving, in ${shownFor.toFixed(0)} ms`);
      await page.waitForTimeout(400);
    }

    // ── Out of the window in one move: gone as from any leaving ──
    {
      const leavesTheWindow = async (name, prepare) => {
        await prepare();
        await record(page);
        const { y } = await middleOf(page, "#zoom-in");
        await page.mouse.move(-40, y, { steps: 1 });
        await page.waitForTimeout(SURFACE_MS + 250);
        const frames = await recorded(page);
        checkFrames(`${level}, ${name}`, frames);
        const gone = frames.findIndex((frame) => shownTips(frame).length === 0);
        assert(gone >= 0, `${level}, ${name}: the tooltip left`);
        assert(frames.slice(gone).every((frame) => shownTips(frame).length === 0), `${level}, ${name}: and stays gone`);
        const shownFor = frames[gone].at - frames[0].at;
        assert(shownFor <= SURFACE_MS + 6 * FRAME_MS, `${level}, ${name}: gone within its leaving, ${shownFor} ms`);
        await page.waitForTimeout(400);
        return shownFor;
      };
      const atRest = await leavesTheWindow("the first tooltip", () => restOn(page, "#zoom-in"));
      const next = await leavesTheWindow("a next tooltip", async () => {
        await restOn(page, "#zoom-out");
        await moveTo(page, "#zoom-in", 6);
        await page.waitForTimeout(40);
      });
      passed(`${level}: out of the window in one move a tooltip goes as from any leaving, the first in ${atRest.toFixed(0)} ms, a next one in ${next.toFixed(0)} ms`);
    }

    // ── 4 px off the button's visible plate, as a menu (user's decision of
    // 15.11.2026; DESIGN_SYSTEM.md, «Отступ от кнопки») ──
    {
      await away(page);
      const gaps = [];
      for (const [selector, name, from] of [["#row40", "a chrome button in a 40 px row", "below"], ["#row30", "a chrome button in a 30 px row", "below"], ["#zoom-in", "a button that is its own plate", "below"], ["#flipped", "a chrome button whose tooltip flips up", "above"]]) {
        await restOn(page, selector);
        const measure = await page.evaluate((id) => {
          const trigger = document.querySelector(id);
          const plate = trigger.querySelector("[data-chrome-plate]") ?? trigger;
          const tip = Array.from(document.querySelectorAll('[data-slot="tooltip-content"]')).find((content) => content.getAttribute("data-state") !== "closed");
          const box = (element) => { const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom }; };
          return { trigger: box(trigger), plate: box(plate), tip: tip ? box(tip) : null, side: tip?.getAttribute("data-side") };
        }, selector);
        assert(measure.tip, `${level}, ${name}: its tooltip is up`);
        const gap = from === "below" ? measure.tip.top - measure.plate.bottom : measure.plate.top - measure.tip.bottom;
        assert.equal(measure.side, from === "below" ? "bottom" : "top", `${level}, ${name}: the side`);
        near(gap, 4, `${level}, ${name}: the gap from the plate`, 0.01);
        const fromBox = from === "below" ? measure.tip.top - measure.trigger.bottom : measure.trigger.top - measure.tip.bottom;
        gaps.push(`${name} ${gap.toFixed(1)} (${fromBox.toFixed(1)} from the box)`);
        await away(page);
      }
      passed(`${level}: a tooltip stands 4 px off its button's visible plate: ${gaps.join("; ")}`);
    }

    // ── A key's focus: at once, staying when the pointer leaves the window ──
    {
      await away(page);
      await page.focus("#zoom-out");
      await page.waitForTimeout(SURFACE_MS + 100);
      await record(page);
      await page.keyboard.press("Tab");
      await page.waitForTimeout(SURFACE_MS + 100);
      const frames = await recorded(page);
      checkFrames(`${level}, Tab`, frames);
      const tips = frames.flatMap((frame) => shownTips(frame).filter((tip) => tip.text === "Zoom in"));
      assert(tips.length > 0, `${level}: Tab brought the next button's tooltip`);
      assert(tips.every((tip) => tip.key), `${level}: it carries the key's mark`);
      near(tips[0].opacity, 1, `${level}: whole in its first frame`, 1e-3);
      await page.mouse.move(-40, 16, { steps: 1 });
      await page.mouse.move(-60, 16, { steps: 1 });
      await page.waitForTimeout(SURFACE_MS + 200);
      const after = (await page.evaluate(() => window.__read())).filter((tip) => tip.shows);
      assert.deepEqual(after.map((tip) => tip.text), ["Zoom in"], `${level}: the focus's tooltip stays`);
      await page.evaluate(() => document.activeElement?.blur());
      passed(`${level}: the keyboard's focus stands its tooltip at once, and it stays when the pointer leaves the window`);
    }

    assert.deepEqual(errors, [], `${level}: page errors`);
    await page.close();
  }
} finally {
  await browser?.close();
  await vite.close();
}
