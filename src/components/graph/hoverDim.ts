// A hovered collection dims the rest of the graph (SPEC_GRAPH_VIEW.md,
// «Приглушение при наведении на коллекцию», user's decision of 16.10.2026).
//
// The lit part is worked out once, when the hovered node or the snapshot
// changes. A frame only asks the sets whether a node or a link is in it: one
// lookup per element once a fade has arrived, one per unfinished fade behind
// it while one runs.

import { easeOutCubic } from "./cameraAnimation";
import type { GraphCanvasLink, GraphCanvasNode } from "./contracts";

/** The part of the graph that stays as it is while a collection is hovered. */
export interface GraphHoverHighlight {
  readonly nodeIds: ReadonlySet<string>;
  readonly linkIds: ReadonlySet<string>;
}

// d3 replaces a link's endpoint ids with the node objects once the
// simulation has started, so both forms arrive here.
type HighlightEndpoint = string | Pick<GraphCanvasNode, "id">;

type HighlightLink = Pick<GraphCanvasLink, "id" | "kind"> & {
  source: HighlightEndpoint;
  target: HighlightEndpoint;
};

function endpointId(endpoint: HighlightEndpoint): string {
  return typeof endpoint === "string" ? endpoint : endpoint.id;
}

/**
 * What stays lit for the hovered node. A collection keeps itself, the cards
 * its membership lines reach and those lines, and nothing else: a wikilink
 * or a related note between two of its cards, or a card's membership in
 * another collection, dims with the rest. A card, or no node, dims nothing,
 * which is `null`.
 */
export function graphHoverHighlight(
  hovered: Pick<GraphCanvasNode, "id" | "kind"> | null,
  links: readonly HighlightLink[],
): GraphHoverHighlight | null {
  if (!hovered || hovered.kind !== "collection") return null;
  const nodeIds = new Set<string>([hovered.id]);
  const linkIds = new Set<string>();
  for (const link of links) {
    if (link.kind !== "collection_membership") continue;
    const source = endpointId(link.source);
    const target = endpointId(link.target);
    if (source !== hovered.id && target !== hovered.id) continue;
    nodeIds.add(source === hovered.id ? target : source);
    linkIds.add(link.id);
  }
  return { nodeIds, linkIds };
}

/**
 * A change of the lit part on its way: every node and link moves from where
 * it stood when the change began to where `to` puts it, over the same eased
 * share of the way.
 */
export interface GraphDimTransition {
  /**
   * Where every element stood when this began: the previous transition,
   * frozen where it was, or null for a graph with nothing dimmed.
   */
  readonly from: GraphDimTransition | null;
  readonly to: GraphHoverHighlight | null;
  readonly startedAt: number;
  readonly durationMs: number;
  /** Eased share of the way, from 0 to 1, advanced once per frame. */
  progress: number;
}

// How many unfinished transitions may stand behind the current one. The
// pointer changes the hover at most once a frame, so this covers a sweep
// across several pills inside one fade; past it the oldest is taken as
// arrived, a step too small to see.
const MAX_FROZEN_DEPTH = 8;

function settled(highlight: GraphHoverHighlight | null): GraphDimTransition {
  return { from: null, to: highlight, startedAt: 0, durationMs: 0, progress: 1 };
}

/** The graph with nothing dimmed and nothing on its way. */
export function restingDimTransition(): GraphDimTransition {
  return settled(null);
}

function frozen(transition: GraphDimTransition, depth: number): GraphDimTransition {
  if (transition.progress >= 1 || depth >= MAX_FROZEN_DEPTH) return settled(transition.to);
  return {
    ...transition,
    from: transition.from && frozen(transition.from, depth + 1),
  };
}

/**
 * The transition to `next`, starting from where every element stands now. A
 * change in the middle of a fade, the pointer crossing a pill and leaving it,
 * turns back from there instead of jumping to where the fade was heading. A
 * zero duration (reduced motion) arrives at once.
 */
export function beginDimTransition(
  current: GraphDimTransition,
  next: GraphHoverHighlight | null,
  now: number,
  durationMs: number,
): GraphDimTransition {
  return {
    from: frozen(current, 0),
    to: next,
    startedAt: now,
    durationMs,
    progress: durationMs > 0 ? 0 : 1,
  };
}

/** The eased share of the way the transition has come by `now`. */
export function dimProgressAt(transition: GraphDimTransition, now: number): number {
  if (transition.durationMs <= 0) return 1;
  const linear = (now - transition.startedAt) / transition.durationMs;
  if (linear >= 1) return 1;
  return easeOutCubic(Math.max(0, linear));
}

function dimmedShare(
  highlight: GraphHoverHighlight | null,
  element: "node" | "link",
  id: string,
): number {
  if (!highlight) return 0;
  const lit = element === "node" ? highlight.nodeIds : highlight.linkIds;
  return lit.has(id) ? 0 : 1;
}

function transitionShare(
  transition: GraphDimTransition | null,
  element: "node" | "link",
  id: string,
): number {
  if (!transition) return 0;
  const to = dimmedShare(transition.to, element, id);
  if (transition.progress >= 1) return to;
  const from = transitionShare(transition.from, element, id);
  return from + (to - from) * transition.progress;
}

/**
 * How opaque a node or a link is drawn on this frame: 1 when lit,
 * `dimmedOpacity` when dimmed (`DEEMPHASIZED_OPACITY` of the colour law), and
 * between the two while a transition runs.
 */
export function graphElementOpacity(
  transition: GraphDimTransition,
  element: "node" | "link",
  id: string,
  dimmedOpacity: number,
): number {
  return 1 - transitionShare(transition, element, id) * (1 - dimmedOpacity);
}

// The colour functions a browser resolves a token to. `var()` and the like
// are not colours and must not read as opaque ones.
const COLOR_FUNCTIONS = new Set([
  "rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color",
]);

type ParsedColor = {
  alpha: number;
  /** The same colour at another alpha, in the form it came in. */
  write: (alpha: number) => string;
};

function parseShare(value: string): number | null {
  const match = /^([\d.]+)(%?)$/.exec(value.trim());
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  return match[2] ? number / 100 : number;
}

function formatAlpha(alpha: number): string {
  return String(Number(Math.min(1, Math.max(0, alpha)).toFixed(4)));
}

function parseCssColor(color: string): ParsedColor | null {
  const value = color.trim();
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (hex) {
    const [red, green, blue] = hex.slice(1).map((channel) => parseInt(channel, 16));
    return { alpha: 1, write: (alpha) => `rgba(${red}, ${green}, ${blue}, ${formatAlpha(alpha)})` };
  }
  // The legacy comma form: rgb(r, g, b) and rgba(r, g, b, a).
  const legacy = /^(rgba?|hsla?)\(([^,()]+),([^,()]+),([^,()]+?)(?:,([^,()]+))?\)$/i.exec(value);
  if (legacy) {
    const alpha = legacy[5] === undefined ? 1 : parseShare(legacy[5]);
    if (alpha === null) return null;
    const name = `${legacy[1]!.toLowerCase().replace(/a$/, "")}a`;
    const channels = [legacy[2], legacy[3], legacy[4]].map((channel) => channel!.trim()).join(", ");
    return { alpha, write: (next) => `${name}(${channels}, ${formatAlpha(next)})` };
  }
  // The modern space form: oklch(L C H), color(srgb r g b / a) and the rest.
  const modern = /^([a-z]+)\(([^()/]+?)(?:\/([^()/]+))?\)$/i.exec(value);
  if (modern && COLOR_FUNCTIONS.has(modern[1]!.toLowerCase())) {
    const alpha = modern[3] === undefined ? 1 : parseShare(modern[3]);
    if (alpha === null) return null;
    const name = modern[1]!;
    const channels = modern[2]!.trim();
    return { alpha, write: (next) => `${name}(${channels} / ${formatAlpha(next)})` };
  }
  return null;
}

const COLOR_CACHE_LIMIT = 16;

/**
 * The colour at `opacity` of its own alpha, remembered per opacity: a frame
 * asks for at most three values, and every link asks. A colour this cannot
 * read is returned as it is.
 */
export function colorAtOpacity(color: string): (opacity: number) => string {
  const parsed = parseCssColor(color);
  const written = new Map<number, string>();
  return (opacity) => {
    if (!parsed || opacity >= 1) return color;
    let result = written.get(opacity);
    if (result === undefined) {
      // A transition asks for a new value every frame; the steady states
      // need two. Forgetting is cheaper than tracking which are still used.
      if (written.size >= COLOR_CACHE_LIMIT) written.clear();
      result = parsed.write(parsed.alpha * opacity);
      written.set(opacity, result);
    }
    return result;
  };
}
