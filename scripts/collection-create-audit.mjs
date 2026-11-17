// Making a collection as a person does, on the app's pages built for
// production (scripts/built-app-pages.mjs) in WebKit without a window
// (DESIGN_SYSTEM.md, «Создание коллекции»; decisions of 16.11.2026):
//
// - `+` with an empty `Find or create...` makes `Untitled Collection` at
//   once, the next `+` makes `Untitled Collection (2)`; no field for a name
//   opens;
// - a name typed in `Find or create...` and `+` make a collection of that
//   name, and the field empties;
// - a card dragged onto `Find or create...` lights the field's words while
//   it is over it, and dropped there makes an untitled collection holding
//   the card.
//
// The backend's stand-in keeps the collections it is asked to make and
// names an untitled one as the backend does (`create_untitled_channel`:
// the first free name, `(2)`, `(3)` after it).
import { webkit } from "playwright";
import { PNG } from "pngjs";
import { installBackend, painted, spaceCards } from "./app-backend-stand-in.mjs";
import { PAGES, serveBuiltApp } from "./built-app-pages.mjs";

const VIEWPORT = { width: 1200, height: 760 };
const picture = (() => {
  const png = new PNG({ width: 400, height: 300 });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([90, 120, 160, 255], i);
  return PNG.sync.write(png);
})();

const failures = [];
function check(ok, label, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(`${label}${detail ? ` (${detail})` : ""}`);
}

const app = await serveBuiltApp({
  name: "collection-create-audit",
  respond(url, response) {
    if (url.pathname !== "/__asset") return false;
    response.writeHead(200, { "Content-Type": "image/png" });
    response.end(picture);
    return true;
  },
});

/** The sidebar's collections as the person reads them: name and count. */
function sidebarRows(page) {
  return page.evaluate(() => [...document.querySelectorAll("[data-sidebar-row][data-sidebar-row-key^='tag:']")]
    .filter((row) => row.getBoundingClientRect().height > 0)
    .map((row) => row.textContent.replace(/\.{2,}/g, " ").replace(/\s+/g, " ").trim()));
}

/** The counts of the rows named `name`: a row's words are its name, its
 *  count, then the words of its Connect button. */
const rowsNamed = (rows, name) => rows
  .map((row) => (row.startsWith(name) ? /^(\d+)/.exec(row.slice(name.length)) : null))
  .filter((match) => match !== null)
  .map((match) => Number(match[1]));

let browser;
try {
  browser = await webkit.launch({ headless: true });
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(installBackend, {
    cards: spaceCards(),
    collections: ["Design"],
    storage: { "mine.motion": "off", theme: "light" },
  });
  await page.goto(`${app.origin}${PAGES.tab}`);
  await page.waitForSelector("[data-block-slug]", { timeout: 60_000 });
  await painted(page, 4);

  const field = page.getByRole("textbox", { name: "Find or create collection" });
  const plus = page.locator("button[data-sidebar-new-collection]");
  const settle = async () => {
    await page.waitForTimeout(400);
    await painted(page, 2);
  };

  // `+` with the field empty, twice.
  await plus.click();
  await settle();
  let rows = await sidebarRows(page);
  check(rowsNamed(rows, "Untitled Collection").length === 1, "+ with an empty field makes Untitled Collection", JSON.stringify(rows));
  const nameField = await page.evaluate(() => document.querySelector("[data-sidebar-new-channel-row] input") !== null);
  check(!nameField, "+ opens no field for a name");
  await plus.click();
  await settle();
  rows = await sidebarRows(page);
  check(rowsNamed(rows, "Untitled Collection (2)").length === 1, "the next + makes Untitled Collection (2)", JSON.stringify(rows));

  // A name typed in the field, then `+`.
  await field.click();
  await page.keyboard.type("  Reading list ", { delay: 30 });
  await plus.click();
  await settle();
  rows = await sidebarRows(page);
  const typed = await field.inputValue();
  check(rowsNamed(rows, "Reading list").length === 1, "a typed name and + make a collection of that name, without the spaces round it", JSON.stringify(rows));
  check(typed === "", "the field empties once the collection is made", JSON.stringify(typed));

  // A card dragged onto the field.
  const card = page.locator("[data-block-slug='card-4']");
  const from = await card.boundingBox();
  const to = await field.boundingBox();
  const brightness = () => page.evaluate(() => {
    const input = document.querySelector("[data-sidebar-top-search]");
    return { over: input?.closest("[data-sidebar-search-drop]")?.hasAttribute("data-sidebar-search-drop-over") ?? false, colour: input ? getComputedStyle(input, "::placeholder").color : null };
  });
  const atRest = await brightness();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2, { steps: 6 });
  await page.waitForTimeout(120);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 8, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 24 });
  await page.waitForTimeout(150);
  await painted(page);
  const over = await brightness();
  console.log(`the field's words at rest ${atRest.colour}, under the card ${over.colour}`);
  check(over.over && over.colour !== atRest.colour, "the field's words light while a card is over it", `${atRest.colour} → ${over.colour}`);
  await page.mouse.up();
  await settle();
  await page.waitForTimeout(400);
  rows = await sidebarRows(page);
  const made = rowsNamed(rows, "Untitled Collection (3)");
  check(made.length === 1, "a card dropped on the field makes the next untitled collection", JSON.stringify(rows));
  check(made[0] === 1, "the new collection's count is 1", JSON.stringify(made));
  const holds = await page.evaluate(() => window.__auditState.cards.find((item) => item.slug === "card-4").collections);
  check(holds.includes("Untitled Collection (3)"), "the dropped card is in the new collection", JSON.stringify(holds));
  const opened = await page.evaluate(() => window.__auditCommands.filter(({ command }) => command === "begin_note_edit").length);
  check(opened === 0, "the drop opens no card");
  check(errors.length === 0, "no page errors", errors.join("; "));
} finally {
  await browser?.close();
  await app.close();
}

if (failures.length > 0) {
  console.error(`Collection create audit failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}
console.log("Collection create audit passed.");
