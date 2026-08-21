import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://localhost:3000/games", { waitUntil: "networkidle", timeout: 90000 }).catch(() => {});
await page.waitForTimeout(1500);
const card = await page.locator('[data-glow-cell][data-glow-role="card"]').first().boundingBox();
if (card) {
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
  await page.mouse.move(card.x + card.width / 2 + 2, card.y + card.height / 2 + 2);
}
await page.waitForTimeout(700);
await page.screenshot({ path: "/Users/i_iii/.claude/jobs/0004dfca/tmp/glow-fixed.png", clip: card ? { x: Math.max(0, card.x - 40), y: Math.max(0, card.y - 40), width: Math.min(900, card.width + 400), height: Math.min(600, card.height + 200) } : undefined });
console.log("captured", JSON.stringify(card));
await browser.close();
