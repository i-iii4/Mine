import type { GraphCanvasLink, GraphCanvasNode } from "./contracts";

export const GRAPH_REFERENCE_DASH_PX = 4;
export const GRAPH_WIKILINK_CURVATURE = 0.14;
export const GRAPH_RELATED_NOTE_CURVATURE = 0.2;

type GraphLinkStyleInput = Pick<GraphCanvasLink, "kind" | "source" | "target">;

/** Returns the semantic Canvas curvature for a graph link. */
export function graphLinkCurvature(link: GraphLinkStyleInput): number {
  if (link.kind === "collection_membership") return 0;

  const magnitude = link.kind === "related_note"
    ? GRAPH_RELATED_NOTE_CURVATURE
    : GRAPH_WIKILINK_CURVATURE;
  return stablePairSign(endpointId(link.source), endpointId(link.target)) * magnitude;
}

/** Returns a zoom-compensated dash pattern for semantic reference links. */
export function graphLinkLineDash(
  link: GraphLinkStyleInput,
  globalScale: number,
): number[] | null {
  if (link.kind === "collection_membership") return null;

  const scale = Number.isFinite(globalScale) && globalScale > 0 ? globalScale : 1;
  const segment = GRAPH_REFERENCE_DASH_PX / scale;
  return [segment, segment];
}

function endpointId(endpoint: string | GraphCanvasNode): string {
  return typeof endpoint === "string" ? endpoint : endpoint.id;
}

function stablePairSign(sourceId: string, targetId: string): 1 | -1 {
  const pair = sourceId < targetId
    ? `${sourceId}\u0000${targetId}`
    : `${targetId}\u0000${sourceId}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < pair.length; index += 1) {
    hash ^= pair.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % 2 === 0 ? 1 : -1;
}
