// A tab's name with an emoji in it, as a person sees it, on the tab bar's
// page built for production (scripts/built-app-pages.mjs) in WebKit without
// a window (DESIGN_SYSTEM.md, «Растворение кромок»; 16.11.2026: the edges'
// dissolve cut the emoji). The backend's stand-in sends the bar its tabs as
// the backend does (`tabbar-state`). For each tab the audit takes the pixels
// of the emoji as the bar draws them, then the same text in the same font at
// the same place with no mask and no clip: every coloured pixel of the
// emoji drawn alone is drawn in the tab, in both themes.
import { webkit } from "playwright";
import { PNG } from "pngjs";
import { installBackend, painted } from "./app-backend-stand-in.mjs";
import { PAGES, serveBuiltApp } from "./built-app-pages.mjs";

const VIEWPORT = { width: 1000, height: 40 };
/** The tabs: an emoji first, in the middle of a name the bar dissolves at
 *  its end, and a tall pair beside letters that reach low. */
const TABS = [
  { id: 1, place: "🍎 Apples" },
  { id: 2, place: "Reading 📚 list of everything saved before the move to the new library" },
  { id: 3, place: "Йога 🧘‍♀️ g" },
];
/** A pixel of the emoji: a colour, where the bar's text and plates are grey. */
const SATURATION = 60;

const failures = [];
function check(ok, label, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(`${label}${detail ? ` (${detail})` : ""}`);
}

/** The coloured pixels of `png` in `box` (device pixels): their count and
 *  their rows, top and bottom. */
function emojiInk(png, box) {
  let count = 0;
  let top = Infinity;
  let bottom = -Infinity;
  for (let y = Math.max(0, box.top); y < Math.min(png.height, box.bottom); y += 1) {
    for (let x = Math.max(0, box.left); x < Math.min(png.width, box.right); x += 1) {
      const at = (y * png.width + x) * 4;
      const [r, g, b] = [png.data[at], png.data[at + 1], png.data[at + 2]];
      if (Math.max(r, g, b) - Math.min(r, g, b) < SATURATION) continue;
      count += 1;
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  return { count, top, bottom };
}

const app = await serveBuiltApp({ name: "tab-title-audit" });
let browser;
try {
  browser = await webkit.launch({ headless: true });
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: theme });
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(installBackend, { label: "tabbar", storage: { "mine.motion": "off", theme } });
    await page.goto(`${app.origin}${PAGES.tabBar}`);
    await page.waitForFunction(() => window.__auditCommands !== undefined && document.getElementById("root")?.childElementCount > 0, null, { timeout: 60_000 });
    await painted(page, 2);
    await page.evaluate((tabs) => window.__auditFire("tabbar-state", {
      window_id: 1,
      tabs: tabs.map((tab) => ({ id: tab.id, space_name: "Mine", place: tab.place, card: null, live: true, history: { back: false, forward: false } })),
      active_tab: 1,
      sidebar_shown: true,
      fullscreen: false,
    }), TABS);
    await page.waitForFunction((count) => document.querySelectorAll("[data-tab-label]").length === count, TABS.length);
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(VIEWPORT.width - 2, VIEWPORT.height - 2);
    await painted(page, 3);
    const labels = await page.evaluate(() => [...document.querySelectorAll("[data-tab-label]")].map((label) => {
      const box = label.getBoundingClientRect();
      const style = getComputedStyle(label);
      // WebKit gives no `font` shorthand of a computed style: each part.
      return {
        text: label.textContent, left: box.left, top: box.top, width: box.width, height: box.height,
        line: { top: box.top + parseFloat(style.paddingTop), height: parseFloat(style.lineHeight) },
        font: { family: style.fontFamily, size: style.fontSize, weight: style.fontWeight, style: style.fontStyle },
        letterSpacing: style.letterSpacing, color: style.color,
      };
    }));
    const drawn = PNG.sync.read(await page.screenshot());

    // The same words, in the same font at the same place, with nothing to
    // cut them: the bar hidden, a plain line over it.
    await page.evaluate((lines) => {
      document.getElementById("root").style.visibility = "hidden";
      for (const line of lines) {
        const plain = document.createElement("span");
        plain.textContent = line.text;
        // On the label's own line: its top and its line height.
        plain.style.cssText = `position:fixed;left:${line.left}px;top:${line.line.top}px;height:${line.line.height}px;line-height:${line.line.height}px;`
          + `font-family:${line.font.family};font-size:${line.font.size};font-weight:${line.font.weight};font-style:${line.font.style};`
          + `letter-spacing:${line.letterSpacing};color:${line.color};white-space:pre;overflow:visible;`;
        document.body.append(plain);
      }
    }, labels);
    await painted(page, 2);
    const plain = PNG.sync.read(await page.screenshot());


    for (const label of labels) {
      // The label's box and 6 px round it: ink cut at the box shows as fewer
      // pixels than the plain line's in the same rows.
      const box = {
        left: Math.floor(label.left * 2),
        right: Math.ceil((label.left + Math.min(label.width, 400)) * 2),
        top: Math.floor((label.top - 6) * 2),
        bottom: Math.ceil((label.top + label.height + 6) * 2),
      };
      const inTab = emojiInk(drawn, box);
      const alone = emojiInk(plain, box);
      const name = `${theme}, «${label.text.slice(0, 24)}»`;
      console.log(`${name}: emoji pixels in the tab ${inTab.count} (rows ${inTab.top}–${inTab.bottom}), drawn alone ${alone.count} (rows ${alone.top}–${alone.bottom})`);
      check(alone.count > 50, `${name}: the emoji is drawn in colour`, String(alone.count));
      check(inTab.top <= alone.top + 1 && inTab.bottom >= alone.bottom - 1, `${name}: the emoji's top and bottom are drawn in the tab`, `tab ${inTab.top}–${inTab.bottom}, alone ${alone.top}–${alone.bottom}`);
      check(inTab.count >= alone.count * 0.97, `${name}: the emoji is drawn whole in the tab`, `${inTab.count} of ${alone.count}`);
    }
    check(errors.length === 0, `${theme}: no page errors`, errors.join("; "));
    await page.close();
  }
} finally {
  await browser?.close();
  await app.close();
}

if (failures.length > 0) {
  console.error(`Tab title audit failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}
console.log("Tab title audit passed: every emoji of a tab's name is drawn whole.");
