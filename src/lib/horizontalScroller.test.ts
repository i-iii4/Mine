import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { answerSwipeQuestion, overHorizontalScroller, scrollsHorizontally } from "./horizontalScroller";

interface Box {
  overflowX?: string;
  clientWidth?: number;
  scrollWidth?: number;
  scrollLeft?: number;
}

/** jsdom has no layout: an element with the widths a real one would report. */
function box({ overflowX = "visible", clientWidth = 300, scrollWidth = 300, scrollLeft = 0 }: Box, parent: Element): HTMLElement {
  const element = document.createElement("div");
  element.style.overflowX = overflowX;
  Object.defineProperties(element, {
    clientWidth: { value: clientWidth },
    scrollWidth: { value: scrollWidth },
    scrollLeft: { value: scrollLeft },
  });
  parent.append(element);
  return element;
}

/** The page finds `element` at any point. */
function pointerOver(element: Element | null): void {
  document.elementFromPoint = vi.fn(() => element);
}

afterEach(() => {
  document.body.replaceChildren();
  delete window.__MINE_HORIZONTAL_SCROLLER_AT__;
  Reflect.deleteProperty(document, "elementFromPoint");
});

describe("scrollsHorizontally", () => {
  it("is true for a wider content that overflow-x lets the person scroll", () => {
    expect(scrollsHorizontally(box({ overflowX: "auto", scrollWidth: 900 }, document.body))).toBe(true);
    expect(scrollsHorizontally(box({ overflowX: "scroll", scrollWidth: 900 }, document.body))).toBe(true);
  });

  it("is false for a content that fits, even under a scrollable overflow", () => {
    expect(scrollsHorizontally(box({ overflowX: "auto" }, document.body))).toBe(false);
    expect(scrollsHorizontally(box({ overflowX: "scroll" }, document.body))).toBe(false);
  });

  it("is false for a wider content that the person cannot scroll", () => {
    for (const overflowX of ["hidden", "clip", "visible"]) {
      expect(scrollsHorizontally(box({ overflowX, scrollWidth: 900 }, document.body))).toBe(false);
    }
  });

  it("stays true at both ends of the element", () => {
    const atEnd = box({ overflowX: "auto", scrollWidth: 900, scrollLeft: 600 }, document.body);
    expect(scrollsHorizontally(atEnd)).toBe(true);
    const atStart = box({ overflowX: "auto", scrollWidth: 900, scrollLeft: 0 }, document.body);
    expect(scrollsHorizontally(atStart)).toBe(true);
  });
});

describe("overHorizontalScroller", () => {
  it("finds the wide element under the pointer", () => {
    pointerOver(box({ overflowX: "auto", scrollWidth: 900 }, document.body));
    expect(overHorizontalScroller(120, 80)).toBe(true);
    expect(document.elementFromPoint).toHaveBeenCalledWith(120, 80);
  });

  it("finds it from a cell inside it, in a vertically scrolling parent", () => {
    // The parent's overflow-x computes to auto beside overflow-y: auto, and its
    // content fits sideways: only the table's block counts.
    const feed = box({ overflowX: "auto" }, document.body);
    feed.style.overflowY = "auto";
    const wide = box({ overflowX: "auto", scrollWidth: 900 }, feed);
    const cell = box({}, wide);
    pointerOver(cell);
    expect(overHorizontalScroller(10, 10)).toBe(true);
  });

  it("does not take a vertically scrolling parent for a sideways scroller", () => {
    const feed = box({ overflowX: "auto" }, document.body);
    feed.style.overflowY = "auto";
    const fitting = box({ overflowX: "auto" }, feed);
    pointerOver(box({}, fitting));
    expect(overHorizontalScroller(10, 10)).toBe(false);
  });

  it("keeps saying yes at the element's end", () => {
    const wide = box({ overflowX: "auto", scrollWidth: 900, scrollLeft: 600 }, document.body);
    pointerOver(box({}, wide));
    expect(overHorizontalScroller(10, 10)).toBe(true);
  });

  it("says no over a wide element clipped by overflow: hidden, and where nothing stands", () => {
    pointerOver(box({ overflowX: "hidden", scrollWidth: 900 }, document.body));
    expect(overHorizontalScroller(10, 10)).toBe(false);
    pointerOver(null);
    expect(overHorizontalScroller(10, 10)).toBe(false);
  });
});

describe("the native question", () => {
  it("is answered by the name the recogniser asks for", () => {
    const rust = readFileSync("src-tauri/src/swipe_gesture.rs", "utf8");
    expect(rust).toContain('const SCROLLER_QUESTION: &str = "__MINE_HORIZONTAL_SCROLLER_AT__";');
    expect(window.__MINE_HORIZONTAL_SCROLLER_AT__).toBeUndefined();
    answerSwipeQuestion();
    expect(window.__MINE_HORIZONTAL_SCROLLER_AT__).toBe(overHorizontalScroller);
  });

  it("is answered by both kinds of page", () => {
    for (const entry of ["src/main.tsx", "src/settings/main.tsx"]) {
      expect(readFileSync(entry, "utf8"), entry).toContain("answerSwipeQuestion();");
    }
  });
});
