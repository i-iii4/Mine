import { describe, expect, it } from "vitest";
import { placeTextSelectionActionBar } from "./textSelectionActionBarPlacement";

const TOOLBAR_WIDTH = 296;
const TOOLBAR_HEIGHT = 32;
const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;

function rect(left: number, top: number, width: number, height: number) {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

describe("placeTextSelectionActionBar", () => {
  it("centers the bar over the selected range when viewport space allows", () => {
    expect(placeTextSelectionActionBar({
      anchorRect: rect(300, 240, 100, 20),
      toolbarWidth: TOOLBAR_WIDTH,
      toolbarHeight: TOOLBAR_HEIGHT,
      viewportWidth: VIEWPORT_WIDTH,
      viewportHeight: VIEWPORT_HEIGHT,
    })).toEqual({
      left: 202,
      top: 200,
      side: "above",
    });
  });

  it("flips below the selection when there is no top room", () => {
    expect(placeTextSelectionActionBar({
      anchorRect: rect(300, 20, 100, 20),
      toolbarWidth: TOOLBAR_WIDTH,
      toolbarHeight: TOOLBAR_HEIGHT,
      viewportWidth: VIEWPORT_WIDTH,
      viewportHeight: VIEWPORT_HEIGHT,
    })).toEqual({
      left: 202,
      top: 48,
      side: "below",
    });
  });

  it("keeps the bar inside the left viewport edge", () => {
    expect(placeTextSelectionActionBar({
      anchorRect: rect(4, 240, 24, 20),
      toolbarWidth: TOOLBAR_WIDTH,
      toolbarHeight: TOOLBAR_HEIGHT,
      viewportWidth: VIEWPORT_WIDTH,
      viewportHeight: VIEWPORT_HEIGHT,
    })).toEqual({
      left: 8,
      top: 200,
      side: "above",
    });
  });

  it("keeps the bar inside a narrower content safe area", () => {
    expect(placeTextSelectionActionBar({
      anchorRect: rect(64, 240, 80, 20),
      toolbarWidth: TOOLBAR_WIDTH,
      toolbarHeight: TOOLBAR_HEIGHT,
      viewportWidth: VIEWPORT_WIDTH,
      viewportHeight: VIEWPORT_HEIGHT,
      safeBounds: {
        left: 48,
        right: 760,
        top: 8,
        bottom: 592,
      },
    })).toEqual({
      left: 48,
      top: 200,
      side: "above",
    });
  });

  it("keeps the bar inside the right viewport edge", () => {
    expect(placeTextSelectionActionBar({
      anchorRect: rect(760, 240, 32, 20),
      toolbarWidth: TOOLBAR_WIDTH,
      toolbarHeight: TOOLBAR_HEIGHT,
      viewportWidth: VIEWPORT_WIDTH,
      viewportHeight: VIEWPORT_HEIGHT,
    })).toEqual({
      left: 496,
      top: 200,
      side: "above",
    });
  });

  it("flips and clamps at the top-right corner", () => {
    expect(placeTextSelectionActionBar({
      anchorRect: rect(760, 10, 32, 20),
      toolbarWidth: TOOLBAR_WIDTH,
      toolbarHeight: TOOLBAR_HEIGHT,
      viewportWidth: VIEWPORT_WIDTH,
      viewportHeight: VIEWPORT_HEIGHT,
    })).toEqual({
      left: 496,
      top: 38,
      side: "below",
    });
  });
});
