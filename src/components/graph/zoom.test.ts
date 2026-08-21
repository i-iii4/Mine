import { describe, expect, it } from "vitest";
import { graphZoomForExtent } from "./interaction";
import type { GraphCanvasNode } from "./contracts";

function node(id: string, x: number, y: number): GraphCanvasNode {
  return {
    id,
    kind: "card",
    label: id,
    slug: id,
    collection_ref: null,
    card_kind: null,
    block_type: null,
    thumbnail: null,
    preview_manifest: null,
    degree: 1,
    x,
    y,
  } as GraphCanvasNode;
}

const viewport = { width: 1280, height: 800 };

describe("graphZoomForExtent", () => {
  it("scales a wide graph down and a small one up, so neither inherits the other's zoom", () => {
    const wide = graphZoomForExtent(
      [node("a", -2_000, 0), node("b", 2_000, 0)],
      viewport,
    );
    const tight = graphZoomForExtent(
      [node("a", -100, 0), node("b", 100, 0)],
      viewport,
    );
    expect(wide).not.toBeNull();
    expect(tight).not.toBeNull();
    expect(wide as number).toBeLessThan(tight as number);
  });

  it("keeps the whole extent inside the viewport with room left to spread", () => {
    const span = 1_000;
    const zoom = graphZoomForExtent(
      [node("a", -span / 2, -200), node("b", span / 2, 200)],
      viewport,
    ) as number;
    // The drawn width must clear the padding on both sides, and stay short of
    // the frame by the allowance the layout is still going to use up.
    expect(span * zoom).toBeLessThan(viewport.width - 56 * 2);
  });

  it("does not divide by a zero extent when a collection holds a single node", () => {
    const zoom = graphZoomForExtent([node("only", 12, 34)], viewport);
    expect(zoom).toBe(1.4);
  });

  it("refuses to guess a scale when nothing is positioned or the viewport is unmeasured", () => {
    expect(graphZoomForExtent([], viewport)).toBeNull();
    expect(graphZoomForExtent([node("a", 0, 0)], { width: 0, height: 0 })).toBeNull();
  });
});
