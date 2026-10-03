import { describe, expect, it } from "vitest";
import { TAB_BAR_HEIGHT_PX, TAB_DETACH_THRESHOLD_PX } from "./constants";
import {
  draggedOffset,
  dropMarkerLeft,
  dropSlot,
  grabPoint,
  moveItem,
  neighbourShift,
  pastDragThreshold,
  pulledOffBar,
  reorderTarget,
  tabCentres,
} from "./tabDrag";

describe("drag threshold (В60)", () => {
  it("keeps a press below 4 px a click", () => {
    expect(pastDragThreshold(3, 0)).toBe(false);
    expect(pastDragThreshold(2, 2)).toBe(false);
  });

  it("starts a drag at 4 px in any direction", () => {
    expect(pastDragThreshold(4, 0)).toBe(true);
    expect(pastDragThreshold(-4, 0)).toBe(true);
    expect(pastDragThreshold(0, 4)).toBe(true);
  });
});

describe("reorder (В60)", () => {
  const row = { width: 100, count: 5 };

  it("follows the pointer within the row", () => {
    expect(draggedOffset({ ...row, fromIndex: 1, dx: 130 })).toBe(130);
    expect(draggedOffset({ ...row, fromIndex: 1, dx: -40 })).toBe(-40);
  });

  it("stops at the ends of the row", () => {
    expect(draggedOffset({ ...row, fromIndex: 1, dx: -300 })).toBe(-100);
    expect(draggedOffset({ ...row, fromIndex: 1, dx: 900 })).toBe(300);
  });

  it("changes places once the tab covers half of a neighbour", () => {
    expect(reorderTarget({ ...row, fromIndex: 1, offset: 49 })).toBe(1);
    expect(reorderTarget({ ...row, fromIndex: 1, offset: 50 })).toBe(2);
    expect(reorderTarget({ ...row, fromIndex: 1, offset: 260 })).toBe(4);
    expect(reorderTarget({ ...row, fromIndex: 3, offset: -151 })).toBe(1);
  });

  it("has nowhere to go with one tab", () => {
    expect(reorderTarget({ width: 100, count: 1, fromIndex: 0, offset: 80 })).toBe(0);
  });

  it("moves the tabs between the two slots by one width toward the gap", () => {
    const shifts = [0, 1, 2, 3, 4].map((index) =>
      neighbourShift({ index, fromIndex: 1, toIndex: 3, width: 100 }),
    );
    expect(shifts).toEqual([0, 0, -100, -100, 0]);
    const back = [0, 1, 2, 3, 4].map((index) =>
      neighbourShift({ index, fromIndex: 3, toIndex: 1, width: 100 }),
    );
    expect(back).toEqual([0, 100, 100, 0, 0]);
  });

  it("orders the list as the backend will after the drop", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
    expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });
});

describe("tear off (В61)", () => {
  const windowWidth = 1200;

  it("keeps the tab while the pointer stays within the threshold below the bar", () => {
    const edge = TAB_BAR_HEIGHT_PX + TAB_DETACH_THRESHOLD_PX;
    expect(pulledOffBar({ clientX: 300, clientY: edge, windowWidth })).toBe(false);
    expect(pulledOffBar({ clientX: 300, clientY: 12, windowWidth })).toBe(false);
  });

  it("tears off further below the bar than the threshold", () => {
    expect(pulledOffBar({ clientX: 300, clientY: TAB_BAR_HEIGHT_PX + TAB_DETACH_THRESHOLD_PX + 1, windowWidth })).toBe(true);
  });

  it("tears off outside the window across or upward", () => {
    expect(pulledOffBar({ clientX: -1, clientY: 12, windowWidth })).toBe(true);
    expect(pulledOffBar({ clientX: windowWidth + 1, clientY: 12, windowWidth })).toBe(true);
    expect(pulledOffBar({ clientX: 300, clientY: -1, windowWidth })).toBe(true);
  });

  it("keeps the grab offset within the tab for the window that carries it", () => {
    // The third tab, 100 px wide, starts at 112 + 200 - 30 = 282 in the bar
    // and was grabbed 18 px into it.
    expect(
      grabPoint({ pressX: 300, pressY: 14, stripLeft: 112, scrollLeft: 30, fromIndex: 2, width: 100 }),
    ).toEqual({ x: 130, y: 14 });
  });

  it("keeps the press point itself for the only tab", () => {
    expect(
      grabPoint({ pressX: 160, pressY: 9, stripLeft: 112, scrollLeft: 0, fromIndex: 0, width: 240 }),
    ).toEqual({ x: 160, y: 9 });
  });
});

describe("a tab from another window (В63)", () => {
  const strip = { stripLeft: 112, scrollLeft: 0, width: 100, count: 3 };

  it("finds the tabs' centres in the bar", () => {
    expect(tabCentres(strip)).toEqual([162, 262, 362]);
    expect(tabCentres({ ...strip, scrollLeft: 100 })).toEqual([62, 162, 262]);
    expect(tabCentres({ ...strip, count: 0 })).toEqual([]);
  });

  it("lands after every tab whose centre is left of the pointer", () => {
    const centres = tabCentres(strip);
    expect(dropSlot(112, centres)).toBe(0);
    expect(dropSlot(161, centres)).toBe(0);
    expect(dropSlot(163, centres)).toBe(1);
    expect(dropSlot(300, centres)).toBe(2);
    expect(dropSlot(363, centres)).toBe(3);
  });

  it("does not count a tab whose centre is exactly under the pointer", () => {
    expect(dropSlot(262, tabCentres(strip))).toBe(1);
  });

  it("lands first or last past the ends, and first in an empty bar", () => {
    const centres = tabCentres(strip);
    expect(dropSlot(20, centres)).toBe(0);
    expect(dropSlot(900, centres)).toBe(3);
    expect(dropSlot(500, [])).toBe(0);
  });

  it("counts a scrolled strip by where its tabs stand now", () => {
    expect(dropSlot(112 + 70, tabCentres({ ...strip, scrollLeft: 100 }))).toBe(2);
  });

  it("centres the marker on the boundary and keeps it inside the row", () => {
    const row = { width: 100, count: 3, markerWidth: 2 };
    expect(dropMarkerLeft({ ...row, slot: 1 })).toBe(99);
    expect(dropMarkerLeft({ ...row, slot: 0 })).toBe(0);
    expect(dropMarkerLeft({ ...row, slot: 3 })).toBe(298);
    expect(dropMarkerLeft({ ...row, count: 0, slot: 0 })).toBe(0);
  });
});
