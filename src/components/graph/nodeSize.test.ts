import { describe, expect, it } from "vitest";
import { graphNodeScreenSize, nearestNeighbourSpacing } from "./nodeSize";
import { CARD_THUMBNAIL_SIZE, GRAPH_NODE_MAX_PX, type GraphCanvasNode } from "./contracts";

const BASE = CARD_THUMBNAIL_SIZE;

function node(id: string, x: number, y: number): GraphCanvasNode {
  return {
    id, kind: "card", label: id, slug: id, collection_ref: null,
    card_kind: null, block_type: null, thumbnail: null,
    preview_manifest: null, degree: 1, x, y,
  } as GraphCanvasNode;
}

describe("graphNodeScreenSize", () => {
  it("grows with the zoom instead of staying the same size for ever", () => {
    // The defect this replaces: approaching spread the links and showed the
    // picture at exactly 32 pixels no matter how close you came.
    expect(graphNodeScreenSize(1, BASE)).toBe(BASE);
    expect(graphNodeScreenSize(2, BASE)).toBe(BASE * 2);
    expect(graphNodeScreenSize(2.5, BASE)).toBeGreaterThan(graphNodeScreenSize(2, BASE));
  });

  it("stops at the ceiling rather than growing without end", () => {
    expect(graphNodeScreenSize(50, BASE)).toBe(GRAPH_NODE_MAX_PX);
    expect(graphNodeScreenSize(1000, BASE)).toBe(GRAPH_NODE_MAX_PX);
  });

  it("never shrinks below the base when zoomed out", () => {
    // At zoom 0.2 the overview is already dense; shrinking further turns it
    // into dust.
    expect(graphNodeScreenSize(0.2, BASE)).toBe(BASE);
    expect(graphNodeScreenSize(0, BASE)).toBe(BASE);
  });

  it("obeys the room the layout actually has, below the ceiling", () => {
    // 60px of spacing means 60px is all a card may occupy, ceiling or not.
    expect(graphNodeScreenSize(10, BASE, 60)).toBe(60);
    // And a spacing tighter than the base still leaves the card readable.
    expect(graphNodeScreenSize(10, BASE, 10)).toBe(BASE);
  });
});

describe("nearestNeighbourSpacing", () => {
  it("measures the crowd, not the closest pair", () => {
    // One overlapping pair must not pin every card in the graph to its size.
    const crowd = Array.from({ length: 40 }, (_, i) => node(`n${i}`, i * 100, 0));
    const withOutlier = [...crowd, node("stuck", 1, 0)];
    const spacing = nearestNeighbourSpacing(withOutlier);
    expect(spacing).not.toBeNull();
    expect(spacing as number).toBeGreaterThan(10);
  });

  it("reports the real spacing of an evenly spread graph", () => {
    const nodes = Array.from({ length: 25 }, (_, i) =>
      node(`n${i}`, (i % 5) * 80, Math.floor(i / 5) * 80));
    expect(nearestNeighbourSpacing(nodes)).toBeCloseTo(80, 0);
  });

  it("finds neighbours across grid cells, not only inside one", () => {
    // Two nodes either side of a cell boundary are neighbours; a grid that only
    // looked inside its own cell would call them infinitely far apart.
    const nodes = [node("a", 43, 0), node("b", 45, 0)];
    expect(nearestNeighbourSpacing(nodes)).toBeCloseTo(2, 5);
  });

  it("returns nothing when there is nothing to measure", () => {
    expect(nearestNeighbourSpacing([])).toBeNull();
    expect(nearestNeighbourSpacing([node("only", 0, 0)])).toBeNull();
  });
});
