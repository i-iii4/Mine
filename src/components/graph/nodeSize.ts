import {
  CARD_COLLISION_RADIUS,
  GRAPH_MAX_ZOOM_FLOOR,
  GRAPH_NODE_FILL_RATIO,
  GRAPH_NODE_SIZE_SETTLE_PX,
  GRAPH_NODE_SIZE_TIME_CONSTANT_MS,
  GRAPH_ZOOM_HEADROOM,
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
 * The zoom past which approaching stops meaning anything.
 *
 * Cards reach their ceiling once the frame holds few enough of them; beyond
 * that point further zoom only pushes them apart, and the scroll runs into an
 * empty field with one picture in it. Derived rather than fixed, because where
 * that point falls depends on how densely the layout sits.
 *
 * `(ceiling / ratio) × sqrt(density)` is the zoom at which the frame holds
 * exactly the count that reaches the ceiling; the headroom above it leaves room
 * to look closely at a single card.
 */
export function maxUsefulZoom(nodes: readonly GraphCanvasNode[]): number | null {
  const placed = nodes.filter(hasNodePosition);
  if (placed.length < 2) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const node of placed) {
    if (node.x < minX) minX = node.x;
    if (node.x > maxX) maxX = node.x;
    if (node.y < minY) minY = node.y;
    if (node.y > maxY) maxY = node.y;
  }
  const spread = Math.max(maxX - minX, 1) * Math.max(maxY - minY, 1);
  const density = placed.length / spread;
  const atCeiling = (GRAPH_NODE_MAX_PX / GRAPH_NODE_FILL_RATIO) * Math.sqrt(density);
  return Math.max(GRAPH_MAX_ZOOM_FLOOR, atCeiling * GRAPH_ZOOM_HEADROOM);
}

/**
 * One step of the current size towards the target.
 *
 * Replaces a hysteresis threshold, which answered the wrong question. The
 * problem was never whether to change size but how: adopting a measurement
 * only once it differed by twelve percent turned every real change into a
 * staircase — the visible three or four pulses when a collection was opened.
 * Smoothing lets small drift dissolve on its own and real changes arrive as one
 * movement.
 *
 * Framerate-independent: the fraction covered depends on elapsed time, not on
 * how many frames happened to fit into it.
 */
export function approachSize(
  current: number,
  target: number,
  elapsedMs: number,
): number {
  if (!Number.isFinite(current)) return target;
  const step = 1 - Math.exp(-Math.max(0, elapsedMs) / GRAPH_NODE_SIZE_TIME_CONSTANT_MS);
  const next = current + (target - current) * step;
  // Landing rather than approaching for ever: below a pixel the difference is
  // not visible and the animation should end so the canvas can pause again.
  return Math.abs(target - next) < GRAPH_NODE_SIZE_SETTLE_PX ? target : next;
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
