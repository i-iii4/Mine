import { describe, expect, it } from "vitest";
import { createGridViewportPaintDiagnostics } from "./gridViewportDiagnostics";
import type { MasonryPosition } from "@/lib/masonryLayout";

function position(index: number, top: number): MasonryPosition {
  return {
    index,
    top,
    left: 0,
    width: 200,
    height: 100,
    bottom: top + 100,
    column: 0,
  };
}

function appendGridItem(
  root: HTMLElement,
  { top, bottom, live }: { top: number; bottom: number; live: boolean },
): void {
  const item = document.createElement("div");
  item.setAttribute("data-feed-grid-item", "");
  item.setAttribute("data-feed-grid-item-top", String(top));
  item.setAttribute("data-feed-grid-item-bottom", String(bottom));
  item.setAttribute("data-feed-grid-item-live", live ? "true" : "false");
  root.appendChild(item);
}

describe("createGridViewportPaintDiagnostics", () => {
  it("reports blank risk when layout has viewport positions but DOM has no mounted item there", () => {
    const root = document.createElement("div");
    appendGridItem(root, { top: 0, bottom: 100, live: true });

    const diagnostics = createGridViewportPaintDiagnostics({
      layoutGenerationKey: "route|width=400",
      positions: [position(0, 0), position(1, 1200)],
      visibleItemCount: 1,
      scrollTop: 1200,
      viewportHeight: 300,
      layoutTotalHeight: 1300,
      scrollElement: root,
      nowMs: 10,
    });

    expect(diagnostics.blankViewportRisk).toBe(true);
    expect(diagnostics.reason).toBe("no-mounted-dom-in-viewport");
    expect(diagnostics.layoutViewportPositionCount).toBe(1);
    expect(diagnostics.domViewportItemCount).toBe(0);
  });

  it("separates live and skeleton DOM items in the current viewport", () => {
    const root = document.createElement("div");
    appendGridItem(root, { top: 100, bottom: 200, live: true });
    appendGridItem(root, { top: 220, bottom: 320, live: false });

    const diagnostics = createGridViewportPaintDiagnostics({
      layoutGenerationKey: "route|width=400",
      positions: [position(0, 100), position(1, 220)],
      visibleItemCount: 2,
      scrollTop: 100,
      viewportHeight: 240,
      layoutTotalHeight: 320,
      scrollElement: root,
      nowMs: 20,
    });

    expect(diagnostics.blankViewportRisk).toBe(false);
    expect(diagnostics.reason).toBe("ok");
    expect(diagnostics.domViewportItemCount).toBe(2);
    expect(diagnostics.liveDomViewportItemCount).toBe(1);
    expect(diagnostics.skeletonDomViewportItemCount).toBe(1);
  });
});
