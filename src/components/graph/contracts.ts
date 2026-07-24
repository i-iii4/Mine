import type { LinkObject, NodeObject } from "react-force-graph-2d";
import type { GraphLink, GraphNode } from "@/types";

export type GraphCanvasNode = GraphNode & NodeObject<GraphNode>;
export type PositionedGraphCanvasNode = GraphCanvasNode & { x: number; y: number };
export type GraphCanvasLink = Omit<GraphLink, "source" | "target"> &
  LinkObject<GraphCanvasNode, GraphLink> & {
    source: string | GraphCanvasNode;
    target: string | GraphCanvasNode;
  };

export type GraphCanvasData = {
  nodes: GraphCanvasNode[];
  links: GraphCanvasLink[];
};

export type GraphPreviewTarget = {
  nodeId: string;
  slug: string;
};

export type GraphPreviewPosition = {
  top: number;
  left: number;
};

export type GraphCardMenuPoint = {
  x: number;
  y: number;
};

export type GraphToggleOption =
  | "include_collections"
  | "include_wikilinks"
  | "include_related_notes"
  | "include_unresolved";

export type GraphPalette = {
  cardFill: string;
  linkDefault: string;
};

export type GraphCanvasTheme = GraphPalette & {
  chromeFill: string;
  border: string;
  mutedText: string;
  foregroundText: string;
  hoverOutline: string;
};

export interface GraphChargeForce {
  strength(accessor: (node: GraphCanvasNode) => number): GraphChargeForce;
  distanceMax(distance: number): GraphChargeForce;
}

export interface GraphCenterForce {
  strength(strength: number): GraphCenterForce;
}

export interface GraphLinkDistanceForce {
  distance(accessor: (link: GraphCanvasLink) => number): GraphLinkDistanceForce;
}

export interface GraphForce {
  (alpha: number): void;
  initialize?: (nodes: GraphCanvasNode[], ...args: unknown[]) => void;
}

export const CARD_THUMBNAIL_SIZE = 32;
export const CARD_COLLISION_RADIUS = 22;
export const COLLECTION_FONT_SIZE = 14;
export const COLLECTION_PAD_X = 12;
export const COLLECTION_HEIGHT = 28;
export const COLLECTION_LABEL_GAP = 2;
export const COLLECTION_LABEL_CLICK_SUPPRESS_MS = 400;
export const COLLECTION_LABEL_COLLISION_ITERATIONS = 6;
export const COLLECTION_COLLISION_RADIUS = 48;
export const GRAPH_PREVIEW_WIDTH = 240;
export const GRAPH_PREVIEW_FALLBACK_HEIGHT = 320;
export const GRAPH_PREVIEW_GAP = 8;
export const GRAPH_PREVIEW_VIEWPORT_MARGIN = 16;
export const GRAPH_SEARCH_DIMMED_ALPHA = 0.15;
export const GRAPH_BACKEND_SEARCH_DELAY_MS = 120;
export const GRAPH_CENTER_MARGIN = 48;
export const GRAPH_CENTER_DURATION_MS = 400;
export const GRAPH_INITIAL_FIT_TICKS = 18;
export const GRAPH_INITIAL_FIT_DURATION_MS = 250;

export const GRAPH_PALETTE: Record<"light" | "dark", GraphPalette> = {
  dark: {
    cardFill: "#181818",
    linkDefault: "#282828",
  },
  light: {
    cardFill: "#f4f4f4",
    linkDefault: "#d8d8d8",
  },
};
