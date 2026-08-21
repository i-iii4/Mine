import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 140));
});
page.on("pageerror", (e) => errors.push("pageerror: " + String(e).slice(0, 140)));

await page.goto("http://localhost:3000/", { waitUntil: "networkidle", timeout: 90000 }).catch(() => {});
await page.waitForTimeout(2000);
await page.mouse.move(700, 500);
await page.waitForTimeout(500);
await page.screenshot({ path: "/Users/i_iii/.claude/jobs/0004dfca/tmp/root-after-strip.png" });

const info = await page.evaluate(() => ({
  cards: document.querySelectorAll('[data-glow-role="card"]').length,
  navLinks: [...document.querySelectorAll("nav a, header a")]
    .map((a) => a.textContent?.trim())
    .filter(Boolean)
    .slice(0, 8),
}));
console.log(JSON.stringify({ ...info, errors: errors.slice(0, 5) }, null, 2));
await browser.close();
