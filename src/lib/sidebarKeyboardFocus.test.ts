import { afterEach, describe, expect, it, vi } from "vitest";
import {
  focusedRowKey,
  scrollSidebarRowIntoView,
  sidebarEnterLabel,
  walkedRow,
} from "./sidebarKeyboardFocus";

const ROWS = ["all", "tag:alpha", "tag:beta"];

describe("the walk over the sidebar's rows", () => {
  it("steps to the neighbour and stops at both ends", () => {
    expect(walkedRow(ROWS, "tag:alpha", 1)).toEqual({ rowKey: "tag:beta", index: 2 });
    expect(walkedRow(ROWS, "tag:alpha", -1)).toEqual({ rowKey: "all", index: 0 });
    expect(walkedRow(ROWS, "tag:beta", 1)).toBeNull();
    expect(walkedRow(ROWS, "all", -1)).toBeNull();
  });
});

describe("the row a focus stands on", () => {
  it("is its own while it is in the list", () => {
    expect(focusedRowKey(["tag:beta", "tag:alpha"], { rowKey: "tag:alpha", index: 0 })).toBe("tag:alpha");
  });

  it("is the one that came to its place once it is gone, or the last row", () => {
    expect(focusedRowKey(["all", "tag:beta"], { rowKey: "tag:alpha", index: 1 })).toBe("tag:beta");
    expect(focusedRowKey(["all"], { rowKey: "tag:alpha", index: 1 })).toBe("all");
  });

  it("is none in an empty list", () => {
    expect(focusedRowKey([], { rowKey: "tag:alpha", index: 1 })).toBeNull();
  });
});

describe("showing a row in the list", () => {
  function list(rowTop: number, rowBottom: number) {
    const nav = document.createElement("nav");
    const row = document.createElement("div");
    nav.style.paddingTop = "8px";
    nav.style.paddingBottom = "32px";
    nav.scrollTop = 100;
    nav.getBoundingClientRect = () => ({ top: 0, bottom: 200 }) as DOMRect;
    row.getBoundingClientRect = () => ({ top: rowTop, bottom: rowBottom }) as DOMRect;
    const scrollTo = vi.fn();
    nav.scrollTo = scrollTo as unknown as typeof nav.scrollTo;
    document.body.append(nav);
    return { nav, row, scrollTo };
  }

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("scrolls just enough, under the top and bottom insets", () => {
    const above = list(-20, 20);
    scrollSidebarRowIntoView(above.nav, above.row, "instant");
    expect(above.scrollTo).toHaveBeenCalledWith({ top: 72, behavior: "instant" });

    const below = list(150, 190);
    scrollSidebarRowIntoView(below.nav, below.row, "instant");
    expect(below.scrollTo).toHaveBeenCalledWith({ top: 122, behavior: "instant" });
  });

  it("moves nothing for a row in view", () => {
    const shown = list(40, 80);
    scrollSidebarRowIntoView(shown.nav, shown.row, "instant");
    expect(shown.scrollTo).not.toHaveBeenCalled();
  });
});

describe("what Enter does on a row, as the bar names it (SPEC_KEYBOARD.md, М6)", () => {
  it("opens the row in the feed, whatever the row", () => {
    expect(sidebarEnterLabel("tag:alpha", false, [])).toBe("Open");
    expect(sidebarEnterLabel("all", false, [])).toBe("Open");
  });

  it("over an open card follows the row's connection", () => {
    expect(sidebarEnterLabel("tag:alpha", true, [])).toBe("Connect");
    expect(sidebarEnterLabel("tag:alpha", true, ["alpha"])).toBe("Disconnect");
  });

  it("names nothing on a row with no such action", () => {
    expect(sidebarEnterLabel("all", true, [])).toBeNull();
  });
});
