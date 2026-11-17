// Pictures whose contents macOS moved to iCloud, as a person meets them, on
// the app's pages built for production (scripts/built-app-pages.mjs) in
// WebKit without a window (SPEC_CLOUD_STORAGE.md, Х5, Х6, Х8, Х9, Х11 and
// «Отказ чтения», О5). The asset protocol answers an original whose read
// iCloud refused as the app does: `503 Service Unavailable` with
// `Retry-After: 1`; the previews in the app's cache stay on disk. The system
// answers `icloud_download_progress` with `not_downloaded`.
//
// - In the feed a card with a preview shows its picture; a card with no
//   preview yet holds its place in the picture's proportion, quiet for
//   1.5 s, then says `In iCloud`.
// - The open card of a picture with a preview shows the preview at once and
//   keeps it; once the original is refused it says the original is in
//   iCloud and offers `Try again`. Once the file is on the Mac again, `Try
//   again` shows the original.
// - The open card of a picture with no preview holds a frame of the
//   picture's size, not an empty card, and says the same.
import { webkit } from "playwright";
import { PNG } from "pngjs";
import { installBackend, painted, spaceCards } from "./app-backend-stand-in.mjs";
import { PAGES, serveBuiltApp } from "./built-app-pages.mjs";

const VIEWPORT = { width: 1200, height: 760 };
/** CLOUD_BADGE_DELAY_MS, src/lib/cloudContent.ts. */
const BADGE_DELAY_MS = 1500;
/** Cards 3, 6, 9… are pictures (spaceCards). */
const WITH_PREVIEW = "card-3";
const WITHOUT_PREVIEW = "card-6";
const IN_ICLOUD = new Set([`/vault/Media/picture-3.png`, `/vault/Media/picture-6.png`]);

function picture(width, height, rgb) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([...rgb, 255], i);
  return PNG.sync.write(png);
}
const ORIGINAL = picture(800, 600, [40, 140, 90]);
const PREVIEW = picture(400, 300, [40, 140, 90]);

const failures = [];
function check(ok, label, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(`${label}${detail ? ` (${detail})` : ""}`);
}

/** The originals iCloud refuses now, and every request of the asset protocol. */
const refused = new Set(IN_ICLOUD);
const requests = [];
const app = await serveBuiltApp({
  name: "icloud-evicted-audit",
  respond(url, response) {
    if (url.pathname !== "/__asset") return false;
    const path = url.searchParams.get("path") ?? "";
    const original = path.startsWith("/vault/");
    // The card with no preview has no file in the cache.
    const status = original && refused.has(path) ? 503 : path.includes(`/${WITHOUT_PREVIEW}.`) ? 404 : 200;
    requests.push({ path, status });
    if (status !== 200) {
      response.writeHead(status, status === 503 ? { "Retry-After": "1" } : {});
      response.end();
      return true;
    }
    response.writeHead(200, { "Content-Type": "image/png" });
    response.end(original ? ORIGINAL : PREVIEW);
    return true;
  },
});

/** What the person sees of a card in the feed. */
function feedCard(page, slug) {
  return page.evaluate((wanted) => {
    const card = document.querySelector(`[data-block-slug="${wanted}"]`);
    if (!card) return null;
    const box = card.getBoundingClientRect();
    const images = [...card.querySelectorAll("img")].map((image) => ({
      loaded: image.complete && image.naturalWidth > 0,
      shown: Number(getComputedStyle(image).opacity) > 0.5 && image.getBoundingClientRect().width > 0,
      width: image.getBoundingClientRect().width,
      height: image.getBoundingClientRect().height,
    }));
    // The picture's place: the surface the badge stands in, or the picture.
    const surface = card.querySelector("[data-card-cloud-badge]")?.offsetParent ?? card.querySelector("img");
    const media = surface?.getBoundingClientRect() ?? null;
    return {
      box: { width: box.width, height: box.height },
      media: media ? { width: media.width, height: media.height } : null,
      images,
      // The badge is the cloud's sign; its words are its title.
      badge: card.querySelector("[data-card-cloud-badge]")?.getAttribute("title") ?? null,
    };
  }, slug);
}

/** What the person sees of the open card's picture. */
function openPicture(page) {
  return page.evaluate(() => {
    // The open card's picture on screen: a second copy of the card may be
    // laid out unseen.
    const frame = [...document.querySelectorAll("[data-detail-image]")].find((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    }) ?? null;
    if (!frame) return null;
    const box = frame.getBoundingClientRect();
    const images = [...frame.querySelectorAll("img")].map((image) => ({
      loaded: image.complete && image.naturalWidth > 0,
      shown: Number(getComputedStyle(image).opacity) > 0.5 && getComputedStyle(image).display !== "none",
      natural: `${image.naturalWidth}x${image.naturalHeight}`,
    }));
    return {
      width: box.width,
      height: box.height,
      images,
      state: frame.querySelector("[data-detail-cloud-state]")?.getAttribute("data-detail-cloud-state") ?? null,
      words: frame.querySelector("[data-detail-cloud-state]")?.textContent?.trim() ?? null,
    };
  });
}

let browser;
try {
  browser = await webkit.launch({ headless: true });
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(installBackend, {
    cards: spaceCards({ inCloud: [WITHOUT_PREVIEW] }),
    // The system's word of the files, by the card's media reference.
    icloud: Object.fromEntries([...IN_ICLOUD].map((path) => [path.replace("/vault/", ""), { status: "not_downloaded", percent: null }])),
    storage: { "mine.motion": "off", theme: "light" },
  });
  const opened = Date.now();
  await page.goto(`${app.origin}${PAGES.tab}`);
  await page.waitForSelector(`[data-block-slug="${WITHOUT_PREVIEW}"]`, { timeout: 60_000 });
  await painted(page, 4);

  // The feed, before the badge's delay: the card with a preview shows its
  // picture; the one without holds the picture's proportion and is quiet.
  const early = { withPreview: await feedCard(page, WITH_PREVIEW), without: await feedCard(page, WITHOUT_PREVIEW), at: Date.now() - opened };
  console.log(`feed after ${early.at} ms: ${JSON.stringify(early)}`);
  check(early.withPreview?.images.some((image) => image.loaded && image.shown), "feed: a card whose original is in iCloud shows its preview");
  if (early.at < BADGE_DELAY_MS) check(early.without?.badge === null, "feed: a card with no preview is quiet before 1.5 s");
  await page.waitForTimeout(BADGE_DELAY_MS + 300);
  const late = await feedCard(page, WITHOUT_PREVIEW);
  console.log(`feed after the delay: ${JSON.stringify(late)}`);
  check(late?.badge === "In iCloud", "feed: a card with no preview says In iCloud after 1.5 s", String(late?.badge));
  const shape = late?.media ? late.media.height / late.media.width : null;
  check(shape !== null && Math.abs(shape - 600 / 800) < 0.05, "feed: a card with no preview holds the picture's proportion", `media ${JSON.stringify(late?.media)}`);
  check((await feedCard(page, WITH_PREVIEW))?.badge === null, "feed: a card with a preview says nothing of iCloud");

  // The open card of the picture with a preview.
  const card = page.locator(`[data-block-slug="${WITH_PREVIEW}"]`);
  const box = await card.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForSelector("[data-detail-image]", { timeout: 5_000 }).catch(() => undefined);
  await painted(page, 4);
  const first = await openPicture(page);
  console.log(`open card with a preview, at once: ${JSON.stringify(first)}`);
  check(first !== null && first.width > 100 && first.height > 50, "open card: the picture's frame stands at once", JSON.stringify(first && { width: first.width, height: first.height }));
  check(first?.images.some((image) => image.loaded && image.shown), "open card: the preview shows at once while the original is in iCloud");
  await page.waitForFunction(() => document.querySelector("[data-detail-cloud-state]") !== null, null, { timeout: BADGE_DELAY_MS + 3_000 }).catch(() => undefined);
  const told = await openPicture(page);
  console.log(`open card with a preview, refused: ${JSON.stringify(told)}`);
  check(told?.images.some((image) => image.loaded && image.shown), "open card: the preview stays once the original is refused");
  check(told?.state === "offline" && /Original is in iCloud/.test(told.words ?? "") && /Try again/.test(told.words ?? ""), "open card: it says the original is in iCloud and offers Try again", String(told?.words));
  // The file comes down; Try again shows the original.
  refused.clear();
  await page.locator("[data-detail-cloud-state] button").locator("visible=true").first().click();
  await page.waitForFunction(() => document.querySelector("[data-detail-cloud-state]") === null, null, { timeout: 4_000 }).catch(() => undefined);
  await painted(page, 4);
  const back = await openPicture(page);
  console.log(`open card after Try again: ${JSON.stringify(back)}`);
  check(back?.state === null && back.images.some((image) => image.loaded && image.shown && image.natural === "800x600"), "open card: once the file is on the Mac, Try again shows the original");
  // Try again asks for the file and does nothing else: the picture's full
  // view, which a press on the picture opens, stays closed.
  const viewer = await page.evaluate(() => [...document.querySelectorAll("[data-image-preview-overlay]")].some((overlay) => overlay.checkVisibility()));
  check(!viewer, "open card: Try again does not open the picture's full view");
  // Escape closes what is open: the full view first, if it opened, then the card.
  if (viewer) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await painted(page, 4);
  const closed = await page.evaluate(() => [...document.querySelectorAll("[data-detail-image]")].some((element) => element.getBoundingClientRect().width > 0));
  check(!closed, "open card: Escape closes it");
  await painted(page, 4);

  // The open card of the picture with no preview.
  for (const path of IN_ICLOUD) refused.add(path);
  const bare = page.locator(`[data-block-slug="${WITHOUT_PREVIEW}"]`);
  await bare.scrollIntoViewIfNeeded();
  const bareBox = await bare.boundingBox();
  await page.mouse.move(bareBox.x + bareBox.width / 2, bareBox.y + bareBox.height / 2, { steps: 8 });
  await page.mouse.click(bareBox.x + bareBox.width / 2, bareBox.y + bareBox.height / 2);
  await page.waitForSelector("[data-detail-image]", { timeout: 5_000 }).catch(() => undefined);
  await page.waitForFunction(() => document.querySelector("[data-detail-cloud-state]") !== null, null, { timeout: BADGE_DELAY_MS + 3_000 }).catch(() => undefined);
  await painted(page, 4);
  const empty = await openPicture(page);
  console.log(`open card with no preview: ${JSON.stringify(empty)}`);
  check(empty !== null && empty.width > 100 && Math.abs(empty.height / empty.width - 0.75) < 0.05, "open card with no preview: a frame of the picture's size, not an empty card", JSON.stringify(empty && { width: empty.width, height: empty.height }));
  check(/Original is in iCloud/.test(empty?.words ?? ""), "open card with no preview: it says the original is in iCloud", String(empty?.words));
  const asked = await page.evaluate(() => window.__auditCommands.filter(({ command }) => command === "icloud_download_progress").map(({ args }) => args.mediaRef));
  console.log(`asked the system about ${JSON.stringify(asked)}; asset requests ${JSON.stringify(requests.filter((request) => request.path.startsWith("/vault/")))}`);
  check(errors.length === 0, "no page errors", errors.join("; "));
} finally {
  await browser?.close();
  await app.close();
}

if (failures.length > 0) {
  console.error(`iCloud evicted audit failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}
console.log("iCloud evicted audit passed.");
