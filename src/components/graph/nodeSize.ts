import {
  CARD_COLLISION_RADIUS,
  GRAPH_NODE_FILL_RATIO,
  GRAPH_NODE_SIZE_HYSTERESIS,
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
  base: number,
  limits: { fillLimit?: number; spacingLimit?: number },
): number {
  // Sizing by zoom alone was the mistake this replaces: distances between nodes
  // are multiplied by the zoom too, so a card and the gap beside it grew at the
  // same rate and the picture never occupied any more of the screen than
  // before. What the eye reads as "closer" is the share of the frame the cards
  // take, and that is what `fillLimit` carries.
  const candidates = [GRAPH_NODE_MAX_PX];
  if (limits.fillLimit !== undefined && Number.isFinite(limits.fillLimit)) {
    candidates.push(limits.fillLimit);
  }
  if (limits.spacingLimit !== undefined && Number.isFinite(limits.spacingLimit)) {
    candidates.push(limits.spacingLimit);
  }
  // Never below the base: a card smaller than 32 pixels is not a picture.
  return Math.max(base, Math.min(...candidates));
}

/**
 * Whether a newly measured size is different enough to adopt.
 *
 * The frame's contents shift with every nudge of the layout, and adopting each
 * measurement made cards visibly swell and shrink while nothing was happening.
 * A card only changes size when the change is worth seeing.
 */
export function sizeChangeIsWorthIt(current: number | null, next: number): boolean {
  if (current === null) return true;
  return Math.abs(next - current) / current > GRAPH_NODE_SIZE_HYSTERESIS;
}

/**
 * The size each node may take if the frame's area is shared out between the
 * nodes currently inside it.
 *
 * `GRAPH_NODE_FILL_RATIO` is the side of that share a card actually occupies;
 * the rest stays as air between neighbours.
 */
export function frameFillSize(
  viewport: { width: number; height: number },
  visibleCount: number,
): number | null {
  if (viewport.width <= 0 || viewport.height <= 0 || visibleCount <= 0) return null;
  const areaPerNode = (viewport.width * viewport.height) / visibleCount;
  return Math.sqrt(areaPerNode) * GRAPH_NODE_FILL_RATIO;
}

/**
 * How many nodes the frame currently holds.
 *
 * Counted from positions and the camera rather than by asking the canvas to
 * project every node: this runs on each zoom step, and a projection call per
 * node per step is work the frame budget does not have.
 */
export function visibleNodeCount(
  nodes: readonly GraphCanvasNode[],
  center: { x: number; y: number },
  viewport: { width: number; height: number },
  zoom: number,
): number {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const halfWidth = viewport.width / (2 * safeZoom);
  const halfHeight = viewport.height / (2 * safeZoom);
  let count = 0;
  for (const node of nodes) {
    if (!hasNodePosition(node)) continue;
    if (Math.abs(node.x - center.x) > halfWidth) continue;
    if (Math.abs(node.y - center.y) > halfHeight) continue;
    count += 1;
  }
  return count;
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
