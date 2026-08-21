import { describe, expect, it } from "vitest";
import {
  frameFillSize,
  graphNodeScreenSize,
  nearestNeighbourSpacing,
  sizeChangeIsWorthIt,
  visibleNodeCount,
} from "./nodeSize";
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
  it("takes the size the frame can afford, not the zoom", () => {
    // The defect this replaces: size grew as base × zoom while the distances
    // between nodes grew by the same factor, so the picture never took up any
    // more of the screen than before.
    expect(graphNodeScreenSize(BASE, { fillLimit: 70 })).toBe(70);
    expect(graphNodeScreenSize(BASE, { fillLimit: 45 })).toBe(45);
  });

  it("stops at the ceiling however empty the frame is", () => {
    expect(graphNodeScreenSize(BASE, { fillLimit: 400 })).toBe(GRAPH_NODE_MAX_PX);
  });

  it("never shrinks below the base however full the frame is", () => {
    expect(graphNodeScreenSize(BASE, { fillLimit: 4 })).toBe(BASE);
  });

  it("yields to the room the layout actually has", () => {
    // A crowded layout overrides a generous frame share: neighbours must not
    // be covered.
    expect(graphNodeScreenSize(BASE, { fillLimit: 90, spacingLimit: 50 })).toBe(50);
    expect(graphNodeScreenSize(BASE, { fillLimit: 50, spacingLimit: 90 })).toBe(50);
  });

  it("falls back to the ceiling when nothing has been measured yet", () => {
    expect(graphNodeScreenSize(BASE, {})).toBe(GRAPH_NODE_MAX_PX);
  });
});

describe("frameFillSize", () => {
  it("gives every node a share of the frame, so fewer nodes means larger ones", () => {
    const viewport = { width: 1280, height: 800 };
    const crowded = frameFillSize(viewport, 60) as number;
    const sparse = frameFillSize(viewport, 20) as number;
    const nearlyEmpty = frameFillSize(viewport, 3) as number;

    expect(crowded).toBeLessThan(sparse);
    expect(sparse).toBeLessThan(nearlyEmpty);
    // Sixty cards in this frame is the first screenshot the user reported as
    // "still tiny": the share is around seventy pixels, not thirty-two.
    expect(crowded).toBeGreaterThan(60);
    expect(crowded).toBeLessThan(80);
  });

  it("leaves air between neighbours rather than tiling the frame", () => {
    const viewport = { width: 1000, height: 1000 };
    const size = frameFillSize(viewport, 100) as number;
    // A hundred nodes over a hundred slots of 100px: a full tiling would be
    // exactly 100, so the share has to be visibly less.
    expect(size).toBeLessThan(100);
  });

  it("measures nothing when there is no frame or nothing in it", () => {
    expect(frameFillSize({ width: 0, height: 0 }, 10)).toBeNull();
    expect(frameFillSize({ width: 800, height: 600 }, 0)).toBeNull();
  });
});

describe("sizeChangeIsWorthIt", () => {
  it("adopts the first measurement", () => {
    expect(sizeChangeIsWorthIt(null, 70)).toBe(true);
  });

  it("ignores the drift a settling layout produces", () => {
    // Nodes nudge each other constantly; taking every measurement made cards
    // swell and shrink while the user was doing nothing.
    expect(sizeChangeIsWorthIt(70, 73)).toBe(false);
    expect(sizeChangeIsWorthIt(70, 67)).toBe(false);
  });

  it("adopts a change large enough to be worth seeing", () => {
    expect(sizeChangeIsWorthIt(70, 90)).toBe(true);
    expect(sizeChangeIsWorthIt(70, 50)).toBe(true);
  });
});

describe("visibleNodeCount", () => {
  const viewport = { width: 400, height: 400 };

  it("counts what the camera holds and ignores the rest", () => {
    const nodes = [node("in", 0, 0), node("edge", 190, 190), node("out", 500, 500)];
    expect(visibleNodeCount(nodes, { x: 0, y: 0 }, viewport, 1)).toBe(2);
  });

  it("holds fewer nodes as the view comes closer", () => {
    const nodes = Array.from({ length: 9 }, (_, i) =>
      node(`n${i}`, ((i % 3) - 1) * 150, (Math.floor(i / 3) - 1) * 150));
    const far = visibleNodeCount(nodes, { x: 0, y: 0 }, viewport, 1);
    const near = visibleNodeCount(nodes, { x: 0, y: 0 }, viewport, 4);
    expect(near).toBeLessThan(far);
  });

  it("ignores nodes the simulation has not placed", () => {
    const unplaced = { ...node("ghost", 0, 0) } as GraphCanvasNode & { x?: number };
    delete unplaced.x;
    expect(visibleNodeCount([unplaced], { x: 0, y: 0 }, viewport, 1)).toBe(0);
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
