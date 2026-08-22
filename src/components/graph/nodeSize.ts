import {
  CARD_GRAPH_SIZE,
  GRAPH_ZOOM_OUT_LIMIT,
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
 * Zoom bounds for the camera.
 *
 * Only the upper one follows from the card: past it a single card would fill
 * the viewport. Zooming out is left open deliberately.
 *
 * Below `GRAPH_NODE_MIN_PX / CARD_GRAPH_SIZE` the card stops shrinking while
 * the distances around it keep going, so cards begin to overlap — the carpet
 * visible on a full library today. That is the accepted trade: seeing the whole
 * graph at once matters more than keeping it uncluttered at the far end, and
 * the alternative is a large graph that can only be panned.
 */
export function graphZoomBounds(): { min: number; max: number } {
  return {
    min: GRAPH_ZOOM_OUT_LIMIT,
    max: GRAPH_NODE_MAX_PX / CARD_GRAPH_SIZE,
  };
}

/// The zoom at which cards stop shrinking and start overlapping. Not a limit —
/// a description of where the trade takes effect.
export function overlapBeginsAtZoom(): number {
  return GRAPH_NODE_MIN_PX / CARD_GRAPH_SIZE;
}
