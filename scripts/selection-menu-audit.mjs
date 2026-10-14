// The Connect menu of search results and the selection menu of the expanded
// card in headless Chromium, on the fixture scripts/fixtures/selection-menu.*
// (SPEC_SEARCH_OVERLAY.md). Starts and stops its own Vite.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { COLD_START_MS, startAuditVite } from "./audit-vite.mjs";

const FIXTURE_PATH = "/scripts/fixtures/selection-menu.html";

const vite = await startAuditVite();
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(COLD_START_MS);
  page.on("pageerror", (error) => { errors.push(error.message); console.error(error.message); });
  const url = new URL(FIXTURE_PATH, vite.origin).href;
  await page.goto(url);
  await page.waitForLoadState("networkidle");
  // A result row's commands show for the row under the pointer
  // (SPEC_CARD_STATES.md, С10); the preview beside the list has none.
  await page.getByRole("option").first().hover();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
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
  await browser?.close();
  await vite.close();
}
