import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

for (const route of process.argv.slice(2)) {
  await page.goto(`http://localhost:3000${route}`, { waitUntil: "networkidle", timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.mouse.move(700, 400);
  await page.mouse.move(702, 402);
  await page.waitForTimeout(500);

  // Any element whose painted background is a pointer-driven radial gradient.
  const found = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      const before = getComputedStyle(el, "::before");
      for (const [layer, style] of [["self", cs], ["::before", before]]) {
        const bg = style.backgroundImage || "";
        if (!bg.includes("radial-gradient")) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 40) continue;
        out.push({
          layer,
          tag: el.tagName.toLowerCase(),
          attrs: el.getAttributeNames().filter((a) => a.startsWith("data-")).join(","),
          cls: (el.className?.toString?.() ?? "").slice(0, 60),
          w: Math.round(r.width), h: Math.round(r.height),
          z: style.zIndex, pos: style.position,
          pointerEvents: style.pointerEvents,
          bg: bg.slice(0, 90),
        });
      }
    }
    return out.sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 6);
  });
  console.log("=== " + route);
  for (const f of found) console.log(JSON.stringify(f));
}
await browser.close();
