import { describe, expect, it } from "vitest";
import {
  approachDensity,
  graphNodeScreenSize,
  layoutDensity,
  maxUsefulZoom,
  nearestNeighbourSpacing,
  zoomForNodeSize,
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
  const density = layoutDensity([
    node("a", 0, 0), node("b", 100, 0), node("c", 0, 100), node("d", 100, 100),
  ]);

  it("follows the zoom proportionally at a fixed density", () => {
    // The property the whole rework exists for: the gesture maps straight onto
    // the size, with nothing discrete or eased between them.
    // Zooms chosen inside the range where neither the floor nor the ceiling
    // clamps, so the proportion is the only thing under test.
    const near = graphNodeScreenSize(1, density);
    const twice = graphNodeScreenSize(2, density);
    expect(twice / near).toBeCloseTo(2, 5);
  });

  it("draws smaller cards in a denser graph at the same zoom", () => {
    // What sizing by zoom alone could not do: a crowded layout has less room
    // per card, whatever the zoom.
    const sparse = layoutDensity([node("a", 0, 0), node("b", 1000, 1000)]) as number;
    const crowded = layoutDensity(
      Array.from({ length: 50 }, (_, i) => node(`n${i}`, (i % 10) * 20, Math.floor(i / 10) * 20)),
    ) as number;
    expect(graphNodeScreenSize(3, crowded)).toBeLessThan(graphNodeScreenSize(3, sparse));
  });

  it("stops at the ceiling and never falls below the floor", () => {
    expect(graphNodeScreenSize(10_000, density)).toBe(GRAPH_NODE_MAX_PX);
    expect(graphNodeScreenSize(0.0001, density)).toBe(BASE);
  });

  it("yields to the room the layout actually has", () => {
    // A crowded patch overrides the zoom: neighbours must not be covered.
    expect(graphNodeScreenSize(1000, density, 50)).toBe(50);
    // But the floor still wins over a spacing tighter than a readable card.
    expect(graphNodeScreenSize(1000, density, 10)).toBe(BASE);
  });

  it("falls back to the ceiling when density has not been measured", () => {
    expect(graphNodeScreenSize(1000, null)).toBe(GRAPH_NODE_MAX_PX);
  });
});

describe("zoomForNodeSize and maxUsefulZoom", () => {
  const density = layoutDensity([
    node("a", 0, 0), node("b", 100, 0), node("c", 0, 100), node("d", 100, 100),
  ]);

  it("inverts the sizing exactly", () => {
    // One formula, read in both directions. A separate one for the limit is
    // how the approach ends up stopping where cards no longer stop growing.
    const zoom = zoomForNodeSize(GRAPH_NODE_MAX_PX, density) as number;
    expect(graphNodeScreenSize(zoom, density)).toBeCloseTo(GRAPH_NODE_MAX_PX, 5);
  });

  it("puts the limit at or past the zoom where cards reach the ceiling", () => {
    const atCeiling = zoomForNodeSize(GRAPH_NODE_MAX_PX, density) as number;
    expect(maxUsefulZoom(density)).toBeGreaterThanOrEqual(atCeiling);
  });

  it("keeps a sparse graph approachable", () => {
    const thin = layoutDensity([node("a", 0, 0), node("b", 100_000, 100_000)]);
    expect(maxUsefulZoom(thin)).toBeGreaterThanOrEqual(2);
  });

  it("declines to guess without a density", () => {
    expect(zoomForNodeSize(GRAPH_NODE_MAX_PX, null)).toBeNull();
    expect(maxUsefulZoom(null)).toBeGreaterThanOrEqual(2);
  });
});

describe("layoutDensity", () => {
  it("reports more nodes per area for a crowded layout", () => {
    const crowded = layoutDensity(
      Array.from({ length: 25 }, (_, i) => node(`c${i}`, (i % 5) * 10, Math.floor(i / 5) * 10)),
    ) as number;
    const spread = layoutDensity(
      Array.from({ length: 25 }, (_, i) => node(`s${i}`, (i % 5) * 200, Math.floor(i / 5) * 200)),
    ) as number;
    expect(crowded).toBeGreaterThan(spread);
  });

  it("declines to measure fewer than two placed nodes", () => {
    expect(layoutDensity([])).toBeNull();
    expect(layoutDensity([node("only", 0, 0)])).toBeNull();
  });
});

describe("approachDensity", () => {
  it("covers part of the distance, not all of it, in one step", () => {
    const next = approachDensity(0.001, 0.01, 16);
    expect(next).toBeGreaterThan(0.001);
    expect(next).toBeLessThan(0.01);
  });

  it("covers the same ground in the same time whatever the framerate", () => {
    let fine = 0.001;
    for (let i = 0; i < 12; i += 1) fine = approachDensity(fine, 0.01, 8);
    let coarse = 0.001;
    for (let i = 0; i < 3; i += 1) coarse = approachDensity(coarse, 0.01, 32);
    expect(fine).toBeCloseTo(coarse, 6);
  });

  it("lands on the target instead of approaching it for ever", () => {
    // The animation has to end, or the canvas can never pause its redraw.
    let value = 0.001;
    for (let i = 0; i < 60; i += 1) value = approachDensity(value, 0.01, 16);
    expect(value).toBe(0.01);
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
