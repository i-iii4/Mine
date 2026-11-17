import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { CARD_DRAG_DROP_EVENT, CARD_DRAG_OVER_EVENT, CARD_TABS_CONFIRM_EVENT, collectionRowAt, openCollectionAt, sidebarSearchAt } from "./remoteCardDrop";

/** The sidebar's rows as the point finds them, the topmost first. */
function under(...rows: (string | null)[]) {
  const elements = rows.map((key) => {
    const element = document.createElement("div");
    if (key !== null) {
      element.setAttribute("data-sidebar-row", "");
      element.dataset.sidebarRowKey = key;
    }
    const child = document.createElement("span");
    element.append(child);
    document.body.append(element);
    return child;
  });
  document.elementsFromPoint = () => elements;
}

describe("cards dragged in another window over this page (SPEC_OUTSIDE_WINDOW.md, ПК4)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("finds the collection's row under the point, the topmost one", () => {
    under("tag:Reading", "tag:Later");
    expect(collectionRowAt(10, 20)).toBe("tag:Reading");
  });

  it("finds nothing over Everything, the create row or anything not a row", () => {
    under("all");
    expect(collectionRowAt(10, 20)).toBeNull();
    under("create-channel");
    expect(collectionRowAt(10, 20)).toBeNull();
    under(null);
    expect(collectionRowAt(10, 20)).toBeNull();
  });

  it("finds the open collection's feed under the point by the drop target's box, and none without one (decision of 16.11.2026)", () => {
    expect(openCollectionAt(500, 300)).toBeNull();
    const target = document.createElement("div");
    target.dataset.openCollectionDrop = "Reading";
    target.getBoundingClientRect = () => ({ left: 350, top: 0, right: 1200, bottom: 800, width: 850, height: 800, x: 350, y: 0, toJSON: () => null });
    document.body.append(target);
    expect(openCollectionAt(500, 300)).toBe("Reading");
    // Over the sidebar, beside the feed: no feed there.
    expect(openCollectionAt(200, 300)).toBeNull();
  });

  it("finds the sidebar's filter under the point, where cards found an untitled collection (decision of 16.11.2026)", () => {
    const surface = document.createElement("div");
    surface.setAttribute("data-sidebar-search-drop", "");
    const field = document.createElement("input");
    surface.append(field);
    document.body.append(surface);
    document.elementsFromPoint = () => [field];
    expect(sidebarSearchAt(10, 20)).toBe(true);
    under("tag:Reading");
    expect(sidebarSearchAt(10, 20)).toBe(false);
  });

  it("hears the backend's events by their names", () => {
    const backend = readFileSync("src-tauri/src/tabs/drag.rs", "utf8");
    for (const name of [CARD_DRAG_OVER_EVENT, CARD_DRAG_DROP_EVENT, CARD_TABS_CONFIRM_EVENT]) {
      expect(backend).toContain(`"${name}"`);
    }
  });
});
