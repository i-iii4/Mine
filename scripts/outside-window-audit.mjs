// The outside window's page in WebKit without a window (SPEC_OUTSIDE_WINDOW.md,
// НО1, ПН8), its own Vite (audit-vite.mjs). It holds what the outside window
// shows to its pixels, in both themes:
//
// - at rest the page draws nothing: every pixel of a snapshot with no
//   background is clear, and the page says it listens;
// - a showing draws its window in the column the backend framed for it: a
//   card and a collection, each opaque, at the column's left, centred on its
//   trigger; its shadow is drawn by the page, lies whole inside the frame, and
//   everything off the window and its field stays clear;
// - the page reports the card settled and its first frame, the backend's
//   deadline (НО9);
// - a dragged card is drawn where the backend's frame has its front card,
//   opaque, its shadow inside the frame, and the page says when it is drawn
//   (ПК1, ПК2).
//
// The page's Tauri is a stand-in that delivers the backend's events and
// records the page's commands, as the menu panel's audit does.
import assert from "node:assert/strict";
import { webkit } from "playwright";
import { PNG } from "pngjs";
import { COLD_START_MS, startAuditVite } from "./audit-vite.mjs";

/** The column's frame of a short bound, the shadow's field round it
 *  (src-tauri/src/outside_window/geometry.rs: 240 + 2 × 22 across). */
const FIELD = 22;
const FRAME = { width: 240 + 2 * FIELD, height: 640 };
const AREA = { left: FIELD, top: FIELD, right: FRAME.width - FIELD, bottom: FRAME.height - FIELD };
const TRIGGER_Y = 300;

function installTauri() {
  const callbacks = new Map();
  const listeners = [];
  let next = 1;
  window.__auditCommands = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "outside-window" }, currentWebview: { label: "outside-window" } },
    transformCallback(callback) {
      const id = next++;
      callbacks.set(id, callback);
      return id;
    },
    async invoke(command, args) {
      if (command === "plugin:event|listen") {
        listeners.push({ event: args.event, handler: args.handler });
        return listeners.length;
      }
      window.__auditCommands.push({ command, args });
      return null;
    },
    convertFileSrc(path) {
      return `asset://localhost${path}`;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__auditFire = (event, payload) => {
    for (const listener of listeners) {
      if (listener.event === event) callbacks.get(listener.handler)?.({ event, id: 0, payload });
    }
  };
}

/** A text card: no picture to fetch, its height its own. */
const CARD = {
  id: 1,
  slug: "a-note",
  block_type: "article",
  card_kind: "article",
  title: "A note kept for later",
  content_heading: null,
  display_title: "A note kept for later",
  fallback_label: "a-note",
  url: null,
  media_file: null,
  thumbnail: null,
  saved_at: "2026-11-16T10:00:00Z",
  width: null,
  height: null,
  author: "Someone",
  body: "The first lines of the note, as the feed shows them under the title.",
  preview_text: "The first lines of the note, as the feed shows them under the title.",
  first_image: null,
  media_urls: null,
  media_dimensions: null,
  preview_manifest: null,
  feed_playback: null,
  collections: ["Reading"],
  search_match: null,
};

const COLLECTION = { row_key: "tag:Reading", name: "Reading", count: 5, cards: [], placeholders: 5 };

/** The dragged card's frame and where its front card stands on the page
 *  (src-tauri/src/outside_window/geometry.rs: 240 + 2 × (22 + 12) across,
 *  the front card at 22 + 12, 22 + 22). */
const DRAG_FRAME = { width: 240 + 2 * (FIELD + 12), height: 640 };
const DRAG_AT = { x: FIELD + 12, y: FIELD + 22 };

const SHAPES = [
  { name: "a card", content: { kind: "card", block: CARD, thumb_version: null } },
  { name: "a collection", content: { kind: "collection", collection: COLLECTION } },
];

/** Pixels with any alpha in `png` outside `rect`. */
function opaqueOutside(png, rect) {
  let count = 0;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const inside = x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
      if (!inside && png.data[(y * png.width + x) * 4 + 3] > 0) count += 1;
    }
  }
  return count;
}

function alphaAt(png, x, y) {
  return png.data[(Math.round(y) * png.width + Math.round(x)) * 4 + 3];
}

const vite = await startAuditVite();
let browser;
const failures = [];
try {
  browser = await webkit.launch({ headless: true });
  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage({ viewport: FRAME, deviceScaleFactor: 1 });
    page.setDefaultNavigationTimeout(COLD_START_MS);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(installTauri);
    await page.addInitScript((theme) => localStorage.setItem("theme", theme), theme);
    await page.goto(`${vite.origin}/outside-window.html`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__auditCommands.some(({ command, args }) => command === "outside_window_report" && args.report.kind === "ready"));

    const rest = PNG.sync.read(await page.screenshot({ omitBackground: true }));
    const restOpaque = opaqueOutside(rest, { x: 0, y: 0, width: 0, height: 0 });
    console.log(`${theme}: at rest ${restOpaque} of ${rest.width * rest.height} pixels not clear`);
    if (restOpaque !== 0) failures.push(`${theme}: the page at rest is not clear`);

    let session = 0;
    for (const shape of SHAPES) {
      const label = `${theme}, ${shape.name}`;
      session += 1;
      await page.evaluate(({ session, area, content, triggerY, look }) => {
        window.__auditCommands.length = 0;
        window.__auditFire("outside-window-message", { kind: "preview", session, area, look });
        window.__auditFire("outside-window-message", {
          kind: "preview_step",
          session,
          number: 1,
          step: { kind: "offer", key: "row", trigger: { x: -300, y: triggerY - 20, width: 280, height: 40 }, content },
        });
      }, { session, area: AREA, content: shape.content, triggerY: TRIGGER_Y, look: { vault_path: "/vault", thumbs_root_path: null, collection_order: [{ tag: "Reading", count: 5 }] } });
      try {
        await page.waitForFunction(() => window.__auditCommands.some(({ args }) => args.report?.kind === "first_frame"), null, { timeout: 5000 });
      } catch {
        failures.push(`${label}: no first frame reported`);
        continue;
      }
      // The fade in is over (Отклик, 150 ms).
      await page.waitForTimeout(400);
      const box = await page.evaluate(() => {
        const shell = document.querySelector("[data-outside-preview]");
        const frame = shell?.querySelector("[data-feed-card-frame]") ?? shell?.querySelector("[data-collection-preview]");
        const rect = frame?.getBoundingClientRect();
        return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
      });
      if (box === null) {
        failures.push(`${label}: the window was not drawn`);
        continue;
      }
      const shot = PNG.sync.read(await page.screenshot({ omitBackground: true }));
      const settled = await page.evaluate(() => window.__auditCommands.some(({ args }) => args.report?.report?.event?.kind === "settled"));
      console.log(`${label}: drawn ${box.width}x${box.height} at ${box.x},${box.y}; settled reported ${settled}`);
      if (!settled) failures.push(`${label}: no settled report`);
      if (Math.abs(box.x - AREA.left) > 0.5) failures.push(`${label}: the window is not at the column's left`);
      if (Math.abs(box.width - 240) > 0.5) failures.push(`${label}: the window is not 240 wide`);
      if (Math.abs(box.y + box.height / 2 - TRIGGER_Y) > 1) failures.push(`${label}: the window is not centred on its trigger`);
      if (alphaAt(shot, box.x + box.width / 2, box.y + box.height / 2) !== 255) failures.push(`${label}: the window is not opaque`);
      if (!(alphaAt(shot, box.x + box.width / 2, box.y + box.height + 6) > 0)) failures.push(`${label}: no shadow under the window`);
      const field = { x: box.x - FIELD, y: box.y - FIELD, width: box.width + 2 * FIELD, height: box.height + 2 * FIELD };
      const stray = opaqueOutside(shot, field);
      if (stray !== 0) failures.push(`${label}: ${stray} pixels drawn off the window and its field`);
      if (field.x < 0 || field.x + field.width > FRAME.width) failures.push(`${label}: the shadow's field leaves the frame`);
      // The showing ends: the page is clear again.
      await page.evaluate((session) => window.__auditFire("outside-window-message", { kind: "end", session, reason: "source" }), session);
      await page.waitForTimeout(50);
      const after = PNG.sync.read(await page.screenshot({ omitBackground: true }));
      if (opaqueOutside(after, { x: 0, y: 0, width: 0, height: 0 }) !== 0) failures.push(`${label}: the page is not clear after the showing ended`);
    }
    {
      const label = `${theme}, a dragged card`;
      await page.setViewportSize(DRAG_FRAME);
      session += 1;
      await page.evaluate(({ session, at, block }) => {
        window.__auditCommands.length = 0;
        window.__auditFire("outside-window-message", {
          kind: "drag",
          session,
          at,
          stack: { blocks: [block], thumb_versions: [null], look: { vault_path: "/vault", thumbs_root_path: null, collection_order: [] } },
        });
      }, { session, at: DRAG_AT, block: CARD });
      try {
        await page.waitForFunction(() => window.__auditCommands.some(({ args }) => args.report?.kind === "drag_shown"), null, { timeout: 5000 });
        const box = await page.evaluate(() => {
          const frame = document.querySelector("[data-outside-drag] [data-feed-card-frame]") ?? document.querySelector("[data-outside-drag] [data-card-preview]");
          const rect = frame?.getBoundingClientRect();
          return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
        });
        if (box === null) {
          failures.push(`${label}: the card was not drawn`);
        } else {
          const shot = PNG.sync.read(await page.screenshot({ omitBackground: true }));
          console.log(`${label}: drawn ${box.width}x${box.height} at ${box.x},${box.y}`);
          if (Math.abs(box.x - DRAG_AT.x) > 0.5 || Math.abs(box.y - DRAG_AT.y) > 0.5) failures.push(`${label}: the card is not where the frame has it`);
          if (alphaAt(shot, box.x + box.width / 2, box.y + box.height / 2) !== 255) failures.push(`${label}: the card is not opaque`);
          if (!(alphaAt(shot, box.x + box.width / 2, box.y + box.height + 6) > 0)) failures.push(`${label}: no shadow under the card`);
          const field = { x: box.x - FIELD, y: box.y - FIELD, width: box.width + 2 * FIELD, height: box.height + 2 * FIELD };
          const stray = opaqueOutside(shot, field);
          if (stray !== 0) failures.push(`${label}: ${stray} pixels drawn off the card and its field`);
        }
      } catch {
        failures.push(`${label}: the page did not say the card is drawn`);
      }
      await page.evaluate((session) => window.__auditFire("outside-window-message", { kind: "drag_end", session }), session);
      await page.waitForTimeout(50);
      const after = PNG.sync.read(await page.screenshot({ omitBackground: true }));
      if (opaqueOutside(after, { x: 0, y: 0, width: 0, height: 0 }) !== 0) failures.push(`${label}: the page is not clear after the drag ended`);
      await page.setViewportSize(FRAME);
    }
    assert.deepEqual(errors, [], `${theme}: page errors`);
    await page.close();
  }
} finally {
  await browser?.close();
  await vite.close();
}
if (failures.length > 0) {
  console.error(`Outside window audit failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("Outside window audit passed: the page is clear at rest, after a showing and after a drag; a card and a collection are drawn opaque in the column, centred on their trigger, their shadow whole inside the frame; a dragged card stands where the frame has it, opaque, its shadow inside; the page reports each.");
