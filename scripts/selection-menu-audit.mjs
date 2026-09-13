import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true, channel: process.env.MINE_AUDIT_BROWSER_CHANNEL || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => { errors.push(error.message); console.error(error.message); });
  const url = process.env.MINE_SELECTION_AUDIT_URL ?? "http://127.0.0.1:1427/scripts/fixtures/selection-menu.html";
  await page.goto(url);
  await page.waitForLoadState("networkidle");
  await page.locator("[data-search-overlay-preview]").hover();
  await page.getByRole("button", { name: /Connect/ }).click();
  const list = page.locator("[data-quantized-menu-scroll-area]");
  await list.waitFor();
  await page.getByRole("menu").evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
  });
  assert.equal(await list.evaluate((el) => !!el.closest('[role="dialog"]')), true);
  const search = page.getByPlaceholder("Search collections...");
  const listBounds = await list.boundingBox();
  await page.mouse.move(listBounds.x + 30, listBounds.y + 30);
  const before = await search.boundingBox();
  await page.mouse.wheel(0, 900);
  await page.waitForFunction(() => document.querySelector("[data-quantized-menu-scroll-area]")?.scrollTop > 0);
  assert.deepEqual(await search.boundingBox(), before);
  await page.getByText("Channel 23", { exact: true }).click();
  console.log("PASS: Connect scrolls to the last channel; search stays fixed");

  await page.goto(`${url}?detail`);
  await page.waitForLoadState("networkidle");
  await page.locator("[data-article-body] p").last().evaluate((paragraph) => {
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.getByRole("button", { name: "Create Element", exact: true }).click();
  await page.getByPlaceholder("Search collections...").fill("Channel 23");
  const target = page.getByRole("menuitem", { name: "Channel 23", exact: true });
  await target.hover();
  await target.click();
  await page.waitForFunction(() => window.auditActions.length === 1);
  const [action] = await page.evaluate(() => window.auditActions);
  assert.equal(action.tag, "Channel 23");
  assert.equal(action.payload.firstBlockStart, 15);
  assert.equal(action.payload.selectedText, "Author: @test");
  assert.deepEqual(errors, []);
  console.log("PASS: selection menu survives focus/hover and creates from the second paragraph");
} finally {
  await browser.close();
}
