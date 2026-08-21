import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://localhost:3000/games", { waitUntil: "networkidle", timeout: 90000 }).catch(() => {});
await page.waitForTimeout(1500);
await page.mouse.move(700, 400);
await page.waitForTimeout(400);
const probe = await page.evaluate(() => {
  const el = document.querySelector('[data-glow-cell][data-glow-role="card"]');
  if (!el) return { found: false };
  const b = getComputedStyle(el, "::before");
  return {
    found: true,
    maskImage: b.maskImage,
    maskComposite: b.maskComposite,
    webkitMaskImage: b.webkitMaskImage,
    webkitMaskComposite: b.webkitMaskComposite,
    maskClip: b.maskClip,
    maskOrigin: b.maskOrigin,
    padding: b.padding,
    inset: `${b.top} ${b.right} ${b.bottom} ${b.left}`,
    zIndex: b.zIndex,
  };
});
console.log(JSON.stringify(probe, null, 2));
await browser.close();
