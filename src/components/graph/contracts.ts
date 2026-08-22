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
  x(x: number): GraphCenterForce;
  y(y: number): GraphCenterForce;
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

// A card node grows with the zoom and stops here. Not a taste: the collision
// force holds card centres 2 * CARD_COLLISION_RADIUS apart, so at the zoom
// where a card reaches 120 screen pixels its neighbours are exactly touching.
// 100 leaves a fifth of the size as air. See SPEC_GRAPH_VIEW.md, «Размер узла».
export const GRAPH_NODE_MAX_PX = 100;

// Side of the frame-share a card occupies. The rest is the air between
// neighbours: at 1.0 the cards would tile the frame edge to edge.
//
// 0.75 rather than something smaller because the floor decides where growth
// begins: at 0.55 a full overview computed 24px, below the 32px floor, so the
// first half of every approach changed nothing at all — the cards sat on the
// floor from 550 nodes in frame down to 194.
export const GRAPH_NODE_FILL_RATIO = 0.75;

// How quickly the layout's measured density is adopted. Roughly the camera's
// own pace, so a collection change and its camera move read as one movement.
// Zoom never passes through this: the hand leads there, and easing would be lag.
export const GRAPH_NODE_SIZE_TIME_CONSTANT_MS = 120;
// Relative distance at which a density transition lands, ending the animation
// so the canvas can pause its redraw again.
export const GRAPH_DENSITY_SETTLE_RATIO = 0.005;

// Relative change a new measurement must exceed to be worth a transition. A
// settling layout emits a stream of slightly different densities, and animating
// each of them is what a collection used to open with — a series of jerks.
export const GRAPH_DENSITY_CHANGE_THRESHOLD = 0.15;

// How much further than the collision radius a settled layout actually spreads.
// Repulsion pushes neighbours past the nominal 2R; measured at 50.7 units
// against 44 on the reference graph.
export const GRAPH_SETTLED_SPREAD = 1.15;

// Corner radius per pixel of growth above the floor size, capped at the radius
// the rest of the interface uses. Measured from the floor so that a card at 32
// pixels has square corners: a radius there is three physical pixels on a
// retina screen, which reads as a blurred edge, not as rounding.
export const GRAPH_CARD_RADIUS_RATIO = 0.075;
export const GRAPH_CARD_RADIUS_MAX_PX = 5;

// Room to overshoot the point where cards reach their ceiling, so a close look
// at one card is still possible.
export const GRAPH_ZOOM_HEADROOM = 1.5;
// Floor for the computed limit: a graph so sparse that the formula asks for
// almost no zoom must still be approachable.
export const GRAPH_MAX_ZOOM_FLOOR = 2;
export const GRAPH_MIN_ZOOM = 0.05;

// How often the layout's actual spacing is remeasured, in engine ticks. It
// changes only as the simulation settles, so a per-frame pass would be waste.
export const SPACING_RECOMPUTE_TICKS = 15;

// Above this on-screen size the micro level has no detail left to give and the
// node switches to the zoom level. Only nodes in the frame ever cross it, so
// the heavy level stays out of the overview.
export const GRAPH_MICRO_LEVEL_MAX_PX = 32;

// How far outside the viewport a node still counts as worth the zoom level, so
// a small pan does not arrive at an empty square.
export const GRAPH_ZOOM_LEVEL_MARGIN_PX = 200;
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
export const GRAPH_CENTER_MARGIN = 48;
export const GRAPH_CENTER_DURATION_MS = 400;
export const GRAPH_INITIAL_FIT_TICKS = 18;
// Where a node the previous snapshot did not have enters from: a phyllotaxis
// spiral around the focus, one ring step per entrant, at the golden angle.
export const GRAPH_ENTRY_SPREAD = 26;
export const GRAPH_ENTRY_ANGLE = Math.PI * (3 - Math.sqrt(5));

// Zoom is recomputed on every navigation, never inherited from the screen
// before it. The extent is read once the layout has taken shape and then
// allowed room to keep spreading, so the graph does not grow out of frame.
export const GRAPH_ZOOM_PADDING_PX = 56;
export const GRAPH_ZOOM_SPREAD_ALLOWANCE = 1.25;
export const GRAPH_ZOOM_MIN = 0.05;
export const GRAPH_ZOOM_MAX = 1.4;

// A snapshot moves the camera once: to the opened collection, or to a fit of
// the whole graph when nothing is opened. Never both.
export type GraphCameraPlan = { kind: "focus" | "fit" } | null;
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
