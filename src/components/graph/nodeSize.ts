import {
  CARD_GRAPH_SIZE,
  GRAPH_NODE_MAX_PX,
  GRAPH_NODE_MIN_PX,
} from "./contracts";

/**
 * On-screen size of a card, in CSS pixels.
 *
 * A card has a size in graph coordinates, exactly as a link has a length, and
 * the camera scales both. Their ratio therefore holds by construction rather
 * than by formula — which is what three earlier models tried and failed to
 * maintain: sizing by zoom moved card and gap together so nothing changed,
 * sizing by the count of nodes in frame was discrete, and sizing by the
 * layout's density answered "how tightly do they stand" when the question was
 * "how many are on screen".
 *
 * Nothing here measures the graph. The screen size is the graph size times the
 * zoom, and the limits below exist only to stop a card from degenerating into a
 * dot or swallowing the viewport.
 */
export function graphNodeScreenSize(zoom: number): number {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return Math.min(GRAPH_NODE_MAX_PX, Math.max(GRAPH_NODE_MIN_PX, CARD_GRAPH_SIZE * safeZoom));
}

/**
 * Zoom bounds that keep a card between its minimum and maximum on screen.
 *
 * The minimum is held by refusing to zoom out further, not by clamping the
 * size. Clamping is what produces overlap: the card stops shrinking while the
 * distances around it keep going, and the graph closes into a carpet. Refusing
 * the zoom keeps card and gap on the same scale at every moment, so overlap
 * cannot arise from the camera at all.
 *
 * The cost is named and deliberate: a graph large enough that its own extent
 * exceeds the viewport at this zoom is panned rather than shown whole.
 */
export function graphZoomBounds(): { min: number; max: number } {
  return {
    min: GRAPH_NODE_MIN_PX / CARD_GRAPH_SIZE,
    max: GRAPH_NODE_MAX_PX / CARD_GRAPH_SIZE,
  };
}
