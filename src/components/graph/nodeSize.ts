import {
  CARD_COLLISION_RADIUS,
  GRAPH_SETTLED_SPREAD,
  CARD_THUMBNAIL_SIZE,
  GRAPH_MAX_ZOOM_FLOOR,
  GRAPH_NODE_FILL_RATIO,
  GRAPH_DENSITY_CHANGE_THRESHOLD,
  GRAPH_DENSITY_SETTLE_RATIO,
  GRAPH_NODE_SIZE_TIME_CONSTANT_MS,
  GRAPH_ZOOM_HEADROOM,
  GRAPH_NODE_MAX_PX,
  type GraphCanvasNode,
} from "./contracts";
import { hasNodePosition } from "./interaction";

/**
 * The density a settled layout will have, before one has been measured.
 *
 * The collision force holds card centres two radii apart, and repulsion pushes
 * them a little further — measured at 50.7 units against the nominal 44, which
 * `GRAPH_SETTLED_SPREAD` carries. Starting from this rather than from nothing
 * is what stops a collection from opening at one size and correcting itself: it
 * lands within a few percent of the measurement that follows, where the nominal
 * radius alone was fifteen percent out.
 */
export function expectedLayoutDensity(): number {
  const spacing = CARD_COLLISION_RADIUS * 2 * GRAPH_SETTLED_SPREAD;
  return 1 / (spacing * spacing);
}

/**
 * Whether a newly measured density is far enough from the current one to be
 * worth a transition.
 *
 * A settling layout produces a stream of slightly different measurements, and
 * starting an animation for each is the series of jerks a collection used to
 * open with.
 */
export function densityChangeIsWorthIt(current: number, next: number): boolean {
  return Math.abs(next - current) / current > GRAPH_DENSITY_CHANGE_THRESHOLD;
}

/**
 * How densely the layout sits: nodes per unit of graph area.
 *
 * Changes only when the layout does, so it is measured when the simulation
 * stops rather than per frame — which is what lets the size below follow the
 * trackpad exactly.
 */
export function layoutDensity(nodes: readonly GraphCanvasNode[]): number | null {
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
  return placed.length / spread;
}

/**
 * On-screen size of a card, in CSS pixels, from the zoom and the layout's
 * density.
 *
 * Two earlier models failed here and the reasons are worth keeping. Tying size
 * to zoom alone made the cards and the gaps between them grow by the same
 * factor, so the share of the screen under pictures never changed. Tying it to
 * the count of nodes in the frame fixed that but made the input discrete — one
 * node leaving the frame moved every card — and the smoothing that hid those
 * steps turned into lag behind the trackpad.
 *
 * The count in a frame is density times frame area, and frame area is the
 * viewport divided by the zoom squared; put that through the same share-of-the
 * frame arithmetic and the size comes out proportional to the zoom, with a
 * coefficient set by density. Continuous in the zoom, so the gesture is
 * followed exactly; dependent on density, so a crowded graph still draws
 * smaller cards than a sparse one at the same zoom.
 *
 * `spacingLimit` is what the layout can actually afford in screen pixels:
 * growing past the distance to the nearest neighbour would cover it.
 */
export function graphNodeScreenSize(
  zoom: number,
  density: number | null,
  spacingLimit?: number,
): number {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const candidates = [GRAPH_NODE_MAX_PX];
  if (density !== null && Number.isFinite(density) && density > 0) {
    candidates.push((safeZoom * GRAPH_NODE_FILL_RATIO) / Math.sqrt(density));
  }
  if (spacingLimit !== undefined && Number.isFinite(spacingLimit)) {
    candidates.push(spacingLimit);
  }
  // Never below the base: a card smaller than 32 pixels is not a picture.
  return Math.max(CARD_THUMBNAIL_SIZE, Math.min(...candidates));
}

/**
 * The zoom at which a card reaches a given size — the inverse of
 * `graphNodeScreenSize`, and the only way the zoom limit is derived.
 *
 * Keeping a separate formula for the limit is how it drifts: change the sizing
 * and the approach would keep stopping where cards used to stop growing.
 */
export function zoomForNodeSize(size: number, density: number | null): number | null {
  if (density === null || !Number.isFinite(density) || density <= 0) return null;
  return (size * Math.sqrt(density)) / GRAPH_NODE_FILL_RATIO;
}

/**
 * The zoom past which approaching stops meaning anything: cards are already at
 * their ceiling and further zoom only pushes them apart.
 */
export function maxUsefulZoom(density: number | null): number {
  const atCeiling = zoomForNodeSize(GRAPH_NODE_MAX_PX, density);
  if (atCeiling === null) return GRAPH_MAX_ZOOM_FLOOR;
  return Math.max(GRAPH_MAX_ZOOM_FLOOR, atCeiling * GRAPH_ZOOM_HEADROOM);
}

/**
 * One step of the current density towards a newly measured one.
 *
 * Density is what smoothing belongs to. It changes without the user's hand on
 * it — a collection opens, a layout settles — so easing it reads as the graph
 * adjusting itself. Zoom is the opposite: the hand is leading, and anything
 * between the gesture and the size is felt as lag. Smoothing the size directly
 * is what made the cards trail the trackpad.
 *
 * Framerate-independent: the fraction covered depends on elapsed time, not on
 * how many frames happened to fit into it.
 */
export function approachDensity(
  current: number,
  target: number,
  elapsedMs: number,
): number {
  if (!Number.isFinite(current)) return target;
  const step = 1 - Math.exp(-Math.max(0, elapsedMs) / GRAPH_NODE_SIZE_TIME_CONSTANT_MS);
  const next = current + (target - current) * step;
  // Landing rather than approaching for ever: below a pixel the difference is
  // not visible and the animation should end so the canvas can pause again.
  return Math.abs(target - next) < target * GRAPH_DENSITY_SETTLE_RATIO ? target : next;
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
