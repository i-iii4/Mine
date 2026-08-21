import {
  CARD_COLLISION_RADIUS,
  GRAPH_NODE_MAX_PX,
  type GraphCanvasNode,
} from "./contracts";
import { hasNodePosition } from "./interaction";

/**
 * On-screen size of a card node, in CSS pixels.
 *
 * The node used to be a constant 32 divided by the zoom, which kept it exactly
 * 32 pixels wide however far you approached: zooming spread the links and never
 * showed the picture any larger. It saturates instead — growing with the zoom
 * until it reaches a ceiling.
 *
 * `spacingLimit` is the ceiling the current layout can actually afford, in
 * screen pixels. Growing past the distance to the nearest neighbour makes cards
 * overlap, and the collision force is soft enough that dense areas sit closer
 * than its nominal radius, so the limit has to come from the layout rather than
 * from the constant.
 */
export function graphNodeScreenSize(
  zoom: number,
  base: number,
  spacingLimit?: number,
): number {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const grown = base * safeZoom;
  const ceiling = spacingLimit !== undefined && Number.isFinite(spacingLimit)
    ? Math.min(GRAPH_NODE_MAX_PX, spacingLimit)
    : GRAPH_NODE_MAX_PX;
  // Never below the base: at zoom < 1 the graph is already dense, and shrinking
  // the cards further would turn the overview into dust.
  return Math.max(base, Math.min(grown, Math.max(base, ceiling)));
}

/**
 * Distance from a node to its nearest neighbour, in graph units, taken as the
 * fifth percentile over the graph rather than the true minimum.
 *
 * A single overlapping pair — two cards the simulation has not yet pushed
 * apart — would otherwise pin every card in the graph to that pair's size. The
 * percentile keeps the limit honest about the crowd without letting one outlier
 * decide for everyone.
 *
 * Uses a uniform grid keyed on the collision diameter, so the cost is linear in
 * the number of nodes instead of quadratic.
 */
/// How far the search widens before giving up on a node having any neighbour.
const SPACING_SEARCH_RINGS = 4;

export function nearestNeighbourSpacing(nodes: readonly GraphCanvasNode[]): number | null {
  const placed = nodes.filter(hasNodePosition);
  if (placed.length < 2) return null;

  const cell = CARD_COLLISION_RADIUS * 2;
  const buckets = new Map<string, { x: number; y: number }[]>();
  const key = (cx: number, cy: number) => `${cx},${cy}`;
  for (const node of placed) {
    const cx = Math.floor(node.x / cell);
    const cy = Math.floor(node.y / cell);
    const bucket = buckets.get(key(cx, cy));
    if (bucket) bucket.push({ x: node.x, y: node.y });
    else buckets.set(key(cx, cy), [{ x: node.x, y: node.y }]);
  }

  const distances: number[] = [];
  for (const node of placed) {
    const cx = Math.floor(node.x / cell);
    const cy = Math.floor(node.y / cell);
    let best = Infinity;
    // Rings widen until a neighbour turns up. A fixed one-cell search dropped
    // every node whose neighbours sat further than one cell away, so a sparse
    // graph contributed only its tightest pairs and they decided the limit for
    // everyone.
    for (let ring = 1; ring <= SPACING_SEARCH_RINGS && !Number.isFinite(best); ring += 1) {
      for (let dx = -ring; dx <= ring; dx += 1) {
        for (let dy = -ring; dy <= ring; dy += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring && ring > 1) continue;
          const bucket = buckets.get(key(cx + dx, cy + dy));
          if (!bucket) continue;
          for (const other of bucket) {
            if (other.x === node.x && other.y === node.y) continue;
            const distance = Math.hypot(other.x - node.x, other.y - node.y);
            if (distance < best) best = distance;
          }
        }
      }
    }
    if (Number.isFinite(best)) distances.push(best);
  }
  if (distances.length === 0) return null;

  distances.sort((a, b) => a - b);
  const index = Math.floor(distances.length * 0.05);
  return distances[Math.min(index, distances.length - 1)] ?? null;
}
