import { describe, expect, it } from "vitest";
import {
  DEFAULT_OVERLAY_BOUNDS, dragOverlay, fitOverlay, OVERLAY_INSET, OVERLAY_MAX_WIDTH, OVERLAY_MIN_HEIGHT, OVERLAY_MIN_WIDTH,
  parseOverlayBounds, resizeOverlay,
} from "./overlayBounds";

// SPEC_CLIPPER.md, «Доработки после живого просмотра», пункт 4 и Р10.
const large = { width: 1440, height: 900 };

describe("the overlay's place and size", () => {
  it("stands in the top right corner, 16 px in, at the old width and its content's height, until moved", () => {
    expect(fitOverlay(DEFAULT_OVERLAY_BOUNDS, large, 600)).toEqual({
      left: large.width - OVERLAY_INSET - OVERLAY_MIN_WIDTH, top: OVERLAY_INSET, width: OVERLAY_MIN_WIDTH,
      height: null, maxHeight: large.height - 2 * OVERLAY_INSET,
    });
  });

  it("keeps the width from 360 to 640 px and the height from 430 px to the window's", () => {
    expect(parseOverlayBounds({ left: 10, top: 20, width: 1000, height: 100 })).toEqual({ left: 10, top: 20, width: OVERLAY_MAX_WIDTH, height: OVERLAY_MIN_HEIGHT });
    expect(fitOverlay({ left: 0, top: 0, width: 200, height: 2000 }, large, 0)).toMatchObject({ width: OVERLAY_MIN_WIDTH, height: large.height });
    const frame = fitOverlay({ left: 100, top: 100, width: 400, height: 500 }, large, 0);
    expect(resizeOverlay(frame, 500, 1000, 1000, large)).toEqual({ left: 100, top: 100, width: OVERLAY_MAX_WIDTH, height: large.height - 100 });
    expect(resizeOverlay(frame, 500, -1000, -1000, large)).toEqual({ left: 100, top: 100, width: OVERLAY_MIN_WIDTH, height: OVERLAY_MIN_HEIGHT });
  });

  it("moves within the window when dragged, keeping its size", () => {
    const bounds = { left: 100, top: 100, width: 400, height: 500 };
    const frame = fitOverlay(bounds, large, 0);
    expect(dragOverlay(bounds, frame, 500, 50, -30, large)).toEqual({ left: 150, top: 70, width: 400, height: 500 });
    expect(dragOverlay(bounds, frame, 500, 5000, 5000, large)).toEqual({ left: large.width - 400, top: large.height - 500, width: 400, height: 500 });
    expect(dragOverlay(bounds, frame, 500, -5000, -5000, large)).toEqual({ left: 0, top: 0, width: 400, height: 500 });
  });

  it("moves in and shrinks to its limits in a smaller window, and comes back to what was set when there is room", () => {
    const bounds = { left: 700, top: 300, width: 600, height: 600 };
    const small = { width: 800, height: 500 };
    expect(fitOverlay(bounds, small, 0)).toEqual({ left: 200, top: 0, width: 600, height: 500, maxHeight: 500 - 2 * OVERLAY_INSET });
    expect(fitOverlay(bounds, { width: 900, height: 700 }, 0)).toMatchObject({ left: 300, top: 100, width: 600, height: 600 });
    expect(fitOverlay(bounds, large, 0)).toMatchObject({ left: 700, top: 300, width: 600, height: 600 });
    expect(fitOverlay(bounds, { width: 500, height: 900 }, 0)).toMatchObject({ left: 0, width: 500 });
    expect(fitOverlay(bounds, { width: 300, height: 900 }, 0)).toMatchObject({ left: 0, width: OVERLAY_MIN_WIDTH });
  });

  it("gives a window lower than the minimum a panel of the window's height", () => {
    expect(fitOverlay({ left: 0, top: 0, width: 400, height: 600 }, { width: 1000, height: 300 }, 0)).toMatchObject({ top: 0, height: 300 });
  });

  it("moves a panel that follows its content up when the content grows past the bottom", () => {
    const placed = { left: 100, top: 700, width: 360, height: null };
    expect(fitOverlay(placed, large, 100)).toMatchObject({ top: 700 });
    expect(fitOverlay(placed, large, 400)).toMatchObject({ top: large.height - 400 });
  });

  it("reads only bounds this version writes, else the default ones", () => {
    expect(parseOverlayBounds(undefined)).toEqual(DEFAULT_OVERLAY_BOUNDS);
    expect(parseOverlayBounds({ left: "1", top: 2, width: "wide" })).toEqual(DEFAULT_OVERLAY_BOUNDS);
    expect(parseOverlayBounds({ left: null, top: null, width: 500, height: null })).toEqual({ left: null, top: null, width: 500, height: null });
  });
});
