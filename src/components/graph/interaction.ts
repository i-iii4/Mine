import { thumbnailLevelUrl, thumbnailUrl, withQueryParam, type ThumbLevel } from "@/lib/assets";
import type { HoverPreviewPlace } from "@/lib/hoverPreviewWindow";
import {
  GRAPH_PREVIEW_GAP,
  GRAPH_PREVIEW_VIEWPORT_MARGIN,
  GRAPH_MICRO_LEVEL_MAX_PX,
  GRAPH_PREVIEW_WIDTH,
  GRAPH_ZOOM_MAX,
  GRAPH_ZOOM_MIN,
  GRAPH_ZOOM_PADDING_PX,
  GRAPH_ZOOM_SPREAD_ALLOWANCE,
  type GraphCanvasNode,
  type GraphCardMenuPoint,
  type PositionedGraphCanvasNode,
} from "./contracts";

export function endpointNode(endpoint: unknown): GraphCanvasNode | null {
  if (endpoint && typeof endpoint === "object" && "kind" in endpoint) {
    return endpoint as GraphCanvasNode;
  }
  return null;
}

export function hasNodePosition(node: GraphCanvasNode): node is PositionedGraphCanvasNode {
  return Number.isFinite(node.x) && Number.isFinite(node.y);
}

/**
 * The zoom a viewport needs to hold every node, with room left for the layout
 * to keep spreading after the extent is read. Returns null when there is
 * nothing positioned to measure — the caller must then leave the camera alone
 * rather than guess a scale.
 */
export function graphZoomForExtent(
  nodes: readonly GraphCanvasNode[],
  viewport: { width: number; height: number },
): number | null {
  if (viewport.width <= 0 || viewport.height <= 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    if (!hasNodePosition(node)) continue;
    if (node.x < minX) minX = node.x;
    if (node.x > maxX) maxX = node.x;
    if (node.y < minY) minY = node.y;
    if (node.y > maxY) maxY = node.y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;

  const usableWidth = Math.max(1, viewport.width - GRAPH_ZOOM_PADDING_PX * 2);
  const usableHeight = Math.max(1, viewport.height - GRAPH_ZOOM_PADDING_PX * 2);
  // A single node has no extent; without a floor the scale would be infinite.
  const spanX = Math.max(maxX - minX, 1) * GRAPH_ZOOM_SPREAD_ALLOWANCE;
  const spanY = Math.max(maxY - minY, 1) * GRAPH_ZOOM_SPREAD_ALLOWANCE;
  const zoom = Math.min(usableWidth / spanX, usableHeight / spanY);
  return Math.min(GRAPH_ZOOM_MAX, Math.max(GRAPH_ZOOM_MIN, zoom));
}

export function compareGraphNodePaintOrder(a: GraphCanvasNode, b: GraphCanvasNode): number {
  return graphNodePaintOrder(a) - graphNodePaintOrder(b);
}

function graphNodePaintOrder(node: GraphCanvasNode): number {
  return node.kind === "collection" ? 1 : 0;
}

/**
 * Where a card's preview stands for its node: under the node, or over it when
 * it does not fit below, from where the node stands on screen. Coordinates
 * only, so it can run every frame the window follows the node.
 */
export function graphPreviewPlace(
  screenPoint: { x: number; y: number },
  container: { left: number; top: number },
  previewHeight: number,
  nodeScreenSize: number,
  viewport: { width: number; height: number },
): HoverPreviewPlace {
  const triggerLeft = container.left + screenPoint.x - nodeScreenSize / 2;
  const triggerTop = container.top + screenPoint.y - nodeScreenSize / 2;
  const triggerBottom = triggerTop + nodeScreenSize;

  const left = Math.max(
    GRAPH_PREVIEW_VIEWPORT_MARGIN,
    Math.min(
      triggerLeft,
      viewport.width - GRAPH_PREVIEW_VIEWPORT_MARGIN - GRAPH_PREVIEW_WIDTH,
    ),
  );
  const canOpenDown =
    triggerBottom + GRAPH_PREVIEW_GAP + previewHeight <=
    viewport.height - GRAPH_PREVIEW_VIEWPORT_MARGIN;
  return canOpenDown
    ? { left, top: triggerBottom + GRAPH_PREVIEW_GAP, side: "below" }
    : {
        left,
        top: Math.max(GRAPH_PREVIEW_VIEWPORT_MARGIN, triggerTop - GRAPH_PREVIEW_GAP - previewHeight),
        side: "above",
      };
}

export function graphClientPointFromEvent(event: Event): GraphCardMenuPoint | null {
  if (!(event instanceof MouseEvent)) return null;
  return { x: event.clientX, y: event.clientY };
}

/// The graph reads a reduced level, never the full thumbnail.
///
/// A node is drawn between 32 and 100 pixels; the full file is 640 on its long
/// side, and the engine keeps it decoded at that size whatever we draw it at.
/// `micro` serves the overview, `zoom` the approached view.
export function graphThumbnailUrl(
  thumbsRootPath: string,
  slug: string,
  thumbVersion: number,
  level: ThumbLevel,
): string {
  const url = thumbnailLevelUrl(thumbsRootPath, slug, level);
  return thumbVersion > 0 ? withQueryParam(url, "v", thumbVersion) : url;
}

/// The full thumbnail, for a card whose levels are missing entirely.
export function graphFullThumbnailUrl(
  thumbsRootPath: string,
  slug: string,
  thumbVersion: number,
): string {
  const url = thumbnailUrl(thumbsRootPath, slug);
  return thumbVersion > 0 ? withQueryParam(url, "v", thumbVersion) : url;
}

/// Which level a node needs at this size. The step is the micro level's own
/// resolution: past 32 logical pixels at double density it has nothing left to
/// show, and holding the line there keeps the heavy level out of the overview.
export function graphThumbLevelFor(nodeScreenSize: number): ThumbLevel {
  return nodeScreenSize > GRAPH_MICRO_LEVEL_MAX_PX ? "zoom" : "micro";
}
