import type { ForceGraphMethods } from "react-force-graph-2d";
import { thumbnailLevelUrl, type ThumbLevel } from "@/lib/assets";
import {
  GRAPH_PREVIEW_GAP,
  GRAPH_PREVIEW_VIEWPORT_MARGIN,
  GRAPH_MICRO_LEVEL_MAX_PX,
  GRAPH_PREVIEW_WIDTH,
  GRAPH_ZOOM_MAX,
  GRAPH_ZOOM_MIN,
  GRAPH_ZOOM_PADDING_PX,
  GRAPH_ZOOM_SPREAD_ALLOWANCE,
  type GraphCanvasLink,
  type GraphCanvasNode,
  type GraphCardMenuPoint,
  type GraphPreviewPosition,
  type PositionedGraphCanvasNode,
} from "./contracts";

export function endpointNode(endpoint: unknown): GraphCanvasNode | null {
  if (endpoint && typeof endpoint === "object" && "kind" in endpoint) {
    return endpoint as GraphCanvasNode;
  }
  return null;
}

export type GraphArrowKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

export function isGraphArrowKey(key: string): key is GraphArrowKey {
  return key === "ArrowUp"
    || key === "ArrowDown"
    || key === "ArrowLeft"
    || key === "ArrowRight";
}

export function directionalGraphNode(
  nodes: GraphCanvasNode[],
  current: GraphCanvasNode | null,
  direction: GraphArrowKey,
  graph: ForceGraphMethods<GraphCanvasNode, GraphCanvasLink> | undefined,
): GraphCanvasNode | null {
  if (!graph) return null;
  const positioned = nodes.filter(hasNodePosition);
  if (positioned.length === 0) return null;
  if (!current || !hasNodePosition(current)) {
    return positioned
      .map((node) => ({ node, point: graph.graph2ScreenCoords(node.x, node.y) }))
      .sort((left, right) => left.point.y - right.point.y || left.point.x - right.point.x)[0]
      ?.node ?? null;
  }

  const origin = graph.graph2ScreenCoords(current.x, current.y);
  const vector = graphDirectionVector(direction);
  let best: { node: GraphCanvasNode; score: number } | null = null;
  for (const candidate of positioned) {
    if (candidate.id === current.id) continue;
    const point = graph.graph2ScreenCoords(candidate.x, candidate.y);
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    const projection = dx * vector.x + dy * vector.y;
    if (projection <= 0) continue;
    const perpendicular = Math.abs(dx * vector.y - dy * vector.x);
    const score = projection + perpendicular * 2;
    if (!best || score < best.score) {
      best = { node: candidate, score };
    }
  }
  return best?.node ?? null;
}

function graphDirectionVector(direction: GraphArrowKey): { x: number; y: number } {
  switch (direction) {
    case "ArrowUp":
      return { x: 0, y: -1 };
    case "ArrowDown":
      return { x: 0, y: 1 };
    case "ArrowLeft":
      return { x: -1, y: 0 };
    case "ArrowRight":
      return { x: 1, y: 0 };
  }
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

export function computeGraphPreviewPosition(
  graph: ForceGraphMethods<GraphCanvasNode, GraphCanvasLink> | undefined,
  container: HTMLElement | null,
  node: GraphCanvasNode | undefined,
  previewHeight: number,
  nodeScreenSize: number,
): GraphPreviewPosition | null {
  if (!graph || !container || !node || !hasNodePosition(node)) return null;

  const containerRect = container.getBoundingClientRect();
  const screenPoint = graph.graph2ScreenCoords(node.x, node.y);
  const triggerLeft = containerRect.left + screenPoint.x - nodeScreenSize / 2;
  const triggerTop = containerRect.top + screenPoint.y - nodeScreenSize / 2;
  const triggerBottom = triggerTop + nodeScreenSize;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  const left = Math.max(
    GRAPH_PREVIEW_VIEWPORT_MARGIN,
    Math.min(
      triggerLeft,
      viewportWidth - GRAPH_PREVIEW_VIEWPORT_MARGIN - GRAPH_PREVIEW_WIDTH,
    ),
  );
  const canOpenDown =
    triggerBottom + GRAPH_PREVIEW_GAP + previewHeight <=
    viewportHeight - GRAPH_PREVIEW_VIEWPORT_MARGIN;
  const top = canOpenDown
    ? triggerBottom + GRAPH_PREVIEW_GAP
    : Math.max(
        GRAPH_PREVIEW_VIEWPORT_MARGIN,
        triggerTop - GRAPH_PREVIEW_GAP - previewHeight,
      );

  return { top, left };
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
  const cacheBuster = thumbVersion > 0 ? `?v=${thumbVersion}` : "";
  return `${thumbnailLevelUrl(thumbsRootPath, slug, level)}${cacheBuster}`;
}

/// Which level a node needs at this size. The step is the micro level's own
/// resolution: past 32 logical pixels at double density it has nothing left to
/// show, and holding the line there keeps the heavy level out of the overview.
export function graphThumbLevelFor(nodeScreenSize: number): ThumbLevel {
  return nodeScreenSize > GRAPH_MICRO_LEVEL_MAX_PX ? "zoom" : "micro";
}
