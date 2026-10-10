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
    expect(resizeOverlay(frame, 500, "bottom-right", 1000, 1000, large)).toEqual({ left: 100, top: 100, width: OVERLAY_MAX_WIDTH, height: large.height - 100 });
    expect(resizeOverlay(frame, 500, "bottom-right", -1000, -1000, large)).toEqual({ left: 100, top: 100, width: OVERLAY_MIN_WIDTH, height: OVERLAY_MIN_HEIGHT });
  });

  // From 400 × 500 at (400, 200), its corners at x 400 and 800, y 200 and 700.
  const placed = fitOverlay({ left: 400, top: 200, width: 400, height: 500 }, large, 0);

  it("resizes by any corner and keeps the opposite one where it was", () => {
    expect(resizeOverlay(placed, 500, "bottom-right", 120, 80, large)).toEqual({ left: 400, top: 200, width: 520, height: 580 });
    expect(resizeOverlay(placed, 500, "top-left", -120, -80, large)).toEqual({ left: 280, top: 120, width: 520, height: 580 });
    expect(resizeOverlay(placed, 500, "top-right", 120, -80, large)).toEqual({ left: 400, top: 120, width: 520, height: 580 });
    expect(resizeOverlay(placed, 500, "bottom-left", -120, 80, large)).toEqual({ left: 280, top: 200, width: 520, height: 580 });
  });

  it("keeps the opposite corner still when a corner meets the size limits", () => {
    // Shrunk past the minimums: the right and bottom edges stay at 800 and 700.
    expect(resizeOverlay(placed, 500, "top-left", 1000, 1000, large)).toEqual({ left: 800 - OVERLAY_MIN_WIDTH, top: 700 - OVERLAY_MIN_HEIGHT, width: OVERLAY_MIN_WIDTH, height: OVERLAY_MIN_HEIGHT });
    expect(resizeOverlay(placed, 500, "top-right", -1000, 1000, large)).toEqual({ left: 400, top: 700 - OVERLAY_MIN_HEIGHT, width: OVERLAY_MIN_WIDTH, height: OVERLAY_MIN_HEIGHT });
    expect(resizeOverlay(placed, 500, "bottom-left", 1000, -1000, large)).toEqual({ left: 800 - OVERLAY_MIN_WIDTH, top: 200, width: OVERLAY_MIN_WIDTH, height: OVERLAY_MIN_HEIGHT });
    // Grown past the widest: the opposite edge stays, the width stops at 640.
    expect(resizeOverlay(placed, 500, "bottom-left", -1000, 0, large)).toEqual({ left: 800 - OVERLAY_MAX_WIDTH, top: 200, width: OVERLAY_MAX_WIDTH, height: 500 });
    expect(resizeOverlay(placed, 500, "top-right", 1000, 0, large)).toEqual({ left: 400, top: 200, width: OVERLAY_MAX_WIDTH, height: 500 });
  });

  it("keeps the opposite corner still when a corner meets the window's edge", () => {
    const near = fitOverlay({ left: 100, top: 50, width: 400, height: 500 }, large, 0);
    // The top left corner stops at the window's corner; the bottom right stays at (500, 550).
    expect(resizeOverlay(near, 500, "top-left", -1000, -1000, large)).toEqual({ left: 0, top: 0, width: 500, height: 550 });
    expect(resizeOverlay(near, 500, "top-right", 2000, -1000, large)).toEqual({ left: 100, top: 0, width: OVERLAY_MAX_WIDTH, height: 550 });
    const low = fitOverlay({ left: 1000, top: 300, width: 400, height: 500 }, large, 0);
    expect(resizeOverlay(low, 500, "bottom-right", 1000, 1000, large)).toEqual({ left: 1000, top: 300, width: large.width - 1000, height: large.height - 300 });
    expect(resizeOverlay(low, 500, "bottom-left", -1000, 1000, large)).toEqual({ left: 1400 - OVERLAY_MAX_WIDTH, top: 300, width: OVERLAY_MAX_WIDTH, height: large.height - 300 });
  });

  it("lets only the minimum height move the fixed corner, where 430 px do not fit above it", () => {
    const short = fitOverlay({ left: 400, top: 0, width: 400, height: null }, large, 300);
    expect(resizeOverlay(short, 300, "top-left", 0, 10, large)).toEqual({ left: 400, top: 0, width: 400, height: OVERLAY_MIN_HEIGHT });
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
