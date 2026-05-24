import type { MasonryPosition } from "@/lib/masonryLayout";

export type GridViewportPaintDiagnosticReason =
  | "ok"
  | "empty-route"
  | "zero-viewport"
  | "no-layout-positions"
  | "no-mounted-dom-in-viewport";

export interface GridViewportPaintDiagnostics {
  checkedAtMs: number;
  layoutGenerationKey: string;
  scrollTop: number;
  viewportHeight: number;
  layoutTotalHeight: number;
  layoutViewportPositionCount: number;
  visibleItemCount: number;
  mountedDomItemCount: number;
  domViewportItemCount: number;
  liveDomViewportItemCount: number;
  skeletonDomViewportItemCount: number;
  scrollBeyondLayout: boolean;
  blankViewportRisk: boolean;
  reason: GridViewportPaintDiagnosticReason;
}

function overlapsViewport(
  top: number,
  bottom: number,
  viewportTop: number,
  viewportBottom: number,
): boolean {
  return bottom >= viewportTop && top <= viewportBottom;
}

function parseFiniteNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function createGridViewportPaintDiagnostics({
  layoutGenerationKey,
  positions,
  visibleItemCount,
  scrollTop,
  viewportHeight,
  layoutTotalHeight,
  scrollElement,
  nowMs = performance.now(),
}: {
  layoutGenerationKey: string;
  positions: readonly MasonryPosition[];
  visibleItemCount: number;
  scrollTop: number;
  viewportHeight: number;
  layoutTotalHeight: number;
  scrollElement: HTMLElement;
  nowMs?: number;
}): GridViewportPaintDiagnostics {
  const viewportTop = scrollTop;
  const viewportBottom = scrollTop + Math.max(0, viewportHeight);
  let layoutViewportPositionCount = 0;

  if (viewportHeight > 0) {
    for (const position of positions) {
      if (overlapsViewport(position.top, position.bottom, viewportTop, viewportBottom)) {
        layoutViewportPositionCount += 1;
      }
    }
  }

  let domViewportItemCount = 0;
  let liveDomViewportItemCount = 0;
  let skeletonDomViewportItemCount = 0;

  const nodes = scrollElement.querySelectorAll<HTMLElement>("[data-feed-grid-item]");
  const mountedDomItemCount = nodes.length;

  for (const node of nodes) {
    const top = parseFiniteNumber(node.getAttribute("data-feed-grid-item-top"));
    const bottom = parseFiniteNumber(node.getAttribute("data-feed-grid-item-bottom"));
    if (top === null || bottom === null) continue;
    if (!overlapsViewport(top, bottom, viewportTop, viewportBottom)) continue;

    domViewportItemCount += 1;
    if (node.getAttribute("data-feed-grid-item-live") === "true") {
      liveDomViewportItemCount += 1;
    } else {
      skeletonDomViewportItemCount += 1;
    }
  }

  const scrollBeyondLayout =
    viewportHeight > 0 &&
    layoutTotalHeight > 0 &&
    scrollTop > layoutTotalHeight + viewportHeight;

  let reason: GridViewportPaintDiagnosticReason = "ok";
  if (positions.length === 0) {
    reason = "empty-route";
  } else if (viewportHeight <= 0) {
    reason = "zero-viewport";
  } else if (layoutViewportPositionCount === 0) {
    reason = "no-layout-positions";
  } else if (domViewportItemCount === 0) {
    reason = "no-mounted-dom-in-viewport";
  }

  return {
    checkedAtMs: nowMs,
    layoutGenerationKey,
    scrollTop,
    viewportHeight,
    layoutTotalHeight,
    layoutViewportPositionCount,
    visibleItemCount,
    mountedDomItemCount,
    domViewportItemCount,
    liveDomViewportItemCount,
    skeletonDomViewportItemCount,
    scrollBeyondLayout,
    blankViewportRisk: reason === "no-mounted-dom-in-viewport",
    reason,
  };
}
