import type { ForceGraphMethods } from "react-force-graph-2d";
import { thumbnailUrl } from "@/lib/assets";
import {
  CARD_THUMBNAIL_SIZE,
  GRAPH_PREVIEW_GAP,
  GRAPH_PREVIEW_VIEWPORT_MARGIN,
  GRAPH_PREVIEW_WIDTH,
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

export function normalizeGraphSearch(query: string): { value: string; alphanumericCount: number } {
  const value = query.trim().toLocaleLowerCase();
  return {
    value,
    alphanumericCount: Array.from(value).filter((character) => /[\p{L}\p{N}]/u.test(character))
      .length,
  };
}

export function graphNodeMatchesSearch(node: GraphCanvasNode, query: string): boolean {
  return [node.label, node.slug, node.collection_ref, node.unresolved_ref]
    .some((value) => value?.toLocaleLowerCase().includes(query));
}

export function graphEndpointId(endpoint: string | GraphCanvasNode): string | null {
  if (typeof endpoint === "string") return endpoint;
  return endpoint.id ?? null;
}

export function canvasColorWithAlpha(color: string, alpha: number): string {
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const expanded = hex.length === 3
      ? hex.split("").map((digit) => `${digit}${digit}`).join("")
      : hex;
    const red = Number.parseInt(expanded.slice(0, 2), 16);
    const green = Number.parseInt(expanded.slice(2, 4), 16);
    const blue = Number.parseInt(expanded.slice(4, 6), 16);
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }

  const rgb = color.match(
    /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*[\d.]+)?\s*\)$/i,
  );
  if (!rgb) return color;
  return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
}

export function hasNodePosition(node: GraphCanvasNode): node is PositionedGraphCanvasNode {
  return Number.isFinite(node.x) && Number.isFinite(node.y);
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
): GraphPreviewPosition | null {
  if (!graph || !container || !node || !hasNodePosition(node)) return null;

  const containerRect = container.getBoundingClientRect();
  const screenPoint = graph.graph2ScreenCoords(node.x, node.y);
  const triggerLeft = containerRect.left + screenPoint.x - CARD_THUMBNAIL_SIZE / 2;
  const triggerTop = containerRect.top + screenPoint.y - CARD_THUMBNAIL_SIZE / 2;
  const triggerBottom = triggerTop + CARD_THUMBNAIL_SIZE;
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

export function graphThumbnailUrl(
  thumbsRootPath: string,
  slug: string,
  thumbVersion: number,
): string {
  const cacheBuster = thumbVersion > 0 ? `?v=${thumbVersion}` : "";
  return `${thumbnailUrl(thumbsRootPath, slug)}${cacheBuster}`;
}
