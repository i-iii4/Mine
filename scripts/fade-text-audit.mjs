// The tab's label line in WebKit without a window (DESIGN_SYSTEM.md,
// «Растворение кромок»; 16.11.2026): `FadeText` clips and masks at its own
// box, and a line set tight cut the top and the bottom of every glyph
// taller than it, an emoji first. For each probe label, in the app's mono
// font and in Departure Mono, the ink of its tallest glyphs (the emoji, «Й»,
// «g»: their bounds as the font measures them, set on the label's own
// baseline) lies inside the label's box, and the label stands where a
// label with no room for them stood: its line one em tall, centred in its
// row.
import assert from "node:assert/strict";
import { webkit } from "playwright";
import { COLD_START_MS, startAuditVite } from "./audit-vite.mjs";

const FONTS = ["default", "departure"];
/** The page, and the probe the audit puts on it: the tab's label line alone. */
const PAGE = "src/dev/fade-text-probe.html";
const PROBE = "src/dev/fadeTextProbe.tsx";

const vite = await startAuditVite();
let browser;
try {
  browser = await webkit.launch({ headless: true });
  for (const font of FONTS) {
    const page = await browser.newPage({ viewport: { width: 400, height: 200 }, deviceScaleFactor: 2 });
    await page.addInitScript((choice) => {
      if (choice !== "default") document.documentElement.setAttribute("data-font-interface", choice);
    }, font);
    await page.goto(`${vite.origin}/${PAGE}`, { waitUntil: "networkidle", timeout: COLD_START_MS });
    await page.addScriptTag({ type: "module", url: `${vite.origin}/${PROBE}` });
    await page.waitForSelector("[data-fade-text]", { timeout: COLD_START_MS });
    await page.evaluate(() => document.fonts.ready);
    const labels = await page.evaluate(() => {
      const context = document.createElement("canvas").getContext("2d");
      return [...document.querySelectorAll("[data-fade-text]")].map((label) => {
        const style = getComputedStyle(label);
        const box = label.getBoundingClientRect();
        const row = label.parentElement.getBoundingClientRect();
        // The label's baseline: a mark of no size at the end of a copy of it,
        // laid out beside it in the same row.
        const copy = label.cloneNode(true);
        const mark = document.createElement("i");
        mark.style.cssText = "display:inline-block;width:0;height:0";
        copy.append(mark);
        label.parentElement.append(copy);
        const baseline = mark.getBoundingClientRect().top;
        copy.remove();
        context.font = style.font;
        const glyphs = [...label.textContent].filter((glyph) => /\p{Extended_Pictographic}|[Йg]/u.test(glyph));
        const ink = glyphs.map((glyph) => {
          const measure = context.measureText(glyph);
          return { glyph, top: baseline - measure.actualBoundingBoxAscent, bottom: baseline + measure.actualBoundingBoxDescent };
        });
        const pad = (side) => parseFloat(style[`padding${side}`]);
        const margin = (side) => parseFloat(style[`margin${side}`]);
        return {
          text: label.textContent,
          box: { top: box.top, bottom: box.bottom },
          line: box.height - pad("Top") - pad("Bottom"),
          outer: box.height + margin("Top") + margin("Bottom"),
          offCentre: (box.top + margin("Top") + box.bottom - margin("Bottom")) / 2 - (row.top + row.bottom) / 2,
          fontSize: parseFloat(style.fontSize),
          overflow: label.getAttribute("data-overflow"),
          ink,
        };
      });
    });
    for (const label of labels) {
      const name = `${font}, «${label.text}»`;
      assert.ok(label.ink.length >= 1, `${name}: no tall glyph to measure`);
      for (const glyph of label.ink) {
        assert.ok(glyph.top >= label.box.top - 0.01, `${name}: «${glyph.glyph}» cut at the top: ink from ${glyph.top}, box from ${label.box.top}`);
        assert.ok(glyph.bottom <= label.box.bottom + 0.01, `${name}: «${glyph.glyph}» cut at the bottom: ink to ${glyph.bottom}, box to ${label.box.bottom}`);
      }
      // The room is the label's own: its line and its place in the row stay.
      assert.ok(Math.abs(label.line - label.fontSize) < 0.01, `${name}: the line is ${label.line}, not one em`);
      assert.ok(Math.abs(label.outer - label.fontSize) < 0.01, `${name}: the label takes ${label.outer} of its row, not one em`);
      assert.ok(Math.abs(label.offCentre) < 0.01, `${name}: the label stands ${label.offCentre} off its row's centre`);
      const room = label.ink.map((glyph) => `«${glyph.glyph}» ${(glyph.top - label.box.top).toFixed(2)} below the top, ${(label.box.bottom - glyph.bottom).toFixed(2)} above the bottom`).join("; ");
      console.log(`${name}: overflow=${label.overflow ?? "none"}; ${room}`);
    }
    await page.close();
  }
  console.log("FadeText audit passed: every tall glyph of a tab's label is drawn inside its box, the label one em tall in its row's centre.");
} finally {
  await browser?.close();
  await vite.close();
}
