import { describe, expect, it } from "vitest";
import { GRAPH_PREVIEW_GAP, GRAPH_PREVIEW_VIEWPORT_MARGIN, GRAPH_PREVIEW_WIDTH } from "./contracts";
import { graphPreviewPlace } from "./interaction";

describe("the preview window's place by a node (SPEC_GRAPH_VIEW.md, «Hover»)", () => {
  const container = { left: 240, top: 40 };
  const viewport = { width: 1400, height: 900 };

  it("stands under the node, from where the node stands on screen", () => {
    expect(graphPreviewPlace({ x: 300, y: 200 }, container, 150, 32, viewport)).toEqual({
      left: 240 + 300 - 16,
      top: 40 + 200 + 16 + GRAPH_PREVIEW_GAP,
      side: "below",
    });
  });

  it("stands over the node when it does not fit below", () => {
    expect(graphPreviewPlace({ x: 300, y: 780 }, container, 150, 32, viewport)).toEqual({
      left: 240 + 300 - 16,
      top: 40 + 780 - 16 - GRAPH_PREVIEW_GAP - 150,
      side: "above",
    });
  });

  it("keeps off the app window's edges across and at the top", () => {
    const nearRight = graphPreviewPlace({ x: 1150, y: 200 }, container, 150, 32, viewport);
    expect(nearRight.left).toBe(1400 - GRAPH_PREVIEW_VIEWPORT_MARGIN - GRAPH_PREVIEW_WIDTH);
    const nearLeft = graphPreviewPlace({ x: -300, y: 200 }, container, 150, 32, viewport);
    expect(nearLeft.left).toBe(GRAPH_PREVIEW_VIEWPORT_MARGIN);
    const tooTall = graphPreviewPlace({ x: 300, y: 100 }, container, 900, 32, viewport);
    expect(tooTall.top).toBe(GRAPH_PREVIEW_VIEWPORT_MARGIN);
    expect(tooTall.side).toBe("above");
  });

  it("scales with the node's size on screen", () => {
    const small = graphPreviewPlace({ x: 300, y: 200 }, container, 150, 32, viewport);
    const large = graphPreviewPlace({ x: 300, y: 200 }, container, 150, 100, viewport);
    expect(large.left).toBe(small.left - 34);
    expect(large.top).toBe(small.top + 34);
  });
});
