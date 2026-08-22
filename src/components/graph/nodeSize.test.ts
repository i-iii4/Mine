import { describe, expect, it } from "vitest";
import { graphNodeScreenSize, graphZoomBounds } from "./nodeSize";
import { CARD_GRAPH_SIZE, GRAPH_NODE_MAX_PX, GRAPH_NODE_MIN_PX } from "./contracts";

describe("graphNodeScreenSize", () => {
  it("is the card's graph size scaled by the camera", () => {
    // Everything else follows from this: a card and a link length share one
    // coordinate system, so their ratio holds without any formula maintaining
    // it.
    expect(graphNodeScreenSize(1)).toBe(CARD_GRAPH_SIZE);
    expect(graphNodeScreenSize(2)).toBe(CARD_GRAPH_SIZE * 2);
    expect(graphNodeScreenSize(1.5) / graphNodeScreenSize(1)).toBeCloseTo(1.5, 5);
  });

  it("stops at the bounds rather than degenerating or swallowing the view", () => {
    expect(graphNodeScreenSize(100)).toBe(GRAPH_NODE_MAX_PX);
    expect(graphNodeScreenSize(0.01)).toBe(GRAPH_NODE_MIN_PX);
  });

  it("treats a nonsense zoom as one", () => {
    expect(graphNodeScreenSize(0)).toBe(CARD_GRAPH_SIZE);
    expect(graphNodeScreenSize(Number.NaN)).toBe(CARD_GRAPH_SIZE);
  });
});

describe("graphZoomBounds", () => {
  it("holds the minimum size by refusing the zoom, not by clamping", () => {
    // Clamping is what lets distances keep shrinking past a card that has
    // stopped, closing the graph into a carpet. At the lower bound the card is
    // exactly at its minimum, so it can never be clamped in practice.
    const bounds = graphZoomBounds();
    expect(graphNodeScreenSize(bounds.min)).toBeCloseTo(GRAPH_NODE_MIN_PX, 5);
    expect(graphNodeScreenSize(bounds.max)).toBeCloseTo(GRAPH_NODE_MAX_PX, 5);
  });

  it("leaves room to approach", () => {
    const bounds = graphZoomBounds();
    expect(bounds.max).toBeGreaterThan(bounds.min);
  });
});
