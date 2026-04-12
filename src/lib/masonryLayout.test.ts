import { describe, expect, it } from "vitest";
import {
  computeMasonryLayout,
  getMasonryColumnCount,
  getVisibleMasonryItems,
} from "./masonryLayout";

describe("masonryLayout", () => {
  it("computes the number of columns from the container width", () => {
    expect(getMasonryColumnCount(1200, 240, 32)).toBe(4);
    expect(getMasonryColumnCount(300, 240, 32)).toBe(1);
  });

  it("places cards into the shortest column", () => {
    const layout = computeMasonryLayout([100, 120, 80, 90], 900, 240, 32);

    expect(layout.columnCount).toBe(3);
    expect(layout.positions.map((position) => [position.column, position.top])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [2, 112],
    ]);
    expect(layout.totalHeight).toBe(202);
  });

  it("returns only items inside the viewport plus overscan", () => {
    const layout = computeMasonryLayout([100, 100, 100, 100, 100], 600, 240, 32);
    const visible = getVisibleMasonryItems(layout.positions, 90, 120, 20, 20);

    expect(visible.map((item) => item.index)).toEqual([0, 1, 2, 3]);
  });
});
