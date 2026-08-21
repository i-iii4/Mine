import { collectionPillBox } from "./canvas";
import { hasNodePosition } from "./interaction";
import {
  COLLECTION_LABEL_COLLISION_ITERATIONS,
  COLLECTION_LABEL_GAP,
  type GraphCanvasNode,
  type GraphForce,
  type PositionedGraphCanvasNode,
} from "./contracts";

export function graphPhysics(nodeCount: number) {
  const scale = Math.max(1, Math.sqrt(nodeCount / 90));
  return {
    // Decay and stop have to agree. At 0.02 the simulation needs 5.7s to reach
    // d3's resting threshold while the timer killed it at 3.5s, with the motion
    // still 14x above that threshold — so every rearrangement was cut off mid
    // stride rather than settling. At 0.045 it comes to rest on its own in
    // ~2.5s; the timer below is only a backstop for a slow machine, never the
    // reason the graph stops.
    alphaDecay: 0.045,
    velocityDecay: 0.36,
    warmupTicks: 80,
    cooldownTime: 8000,
    chargeDistanceMax: 220 * scale,
    centerStrength: 0.035 / scale,
    cardCharge: -72 * scale,
    collectionCharge: -115 * scale,
    cardLinkDistance: 56 * scale,
    collectionLinkDistance: 76 * scale,
  };
}

export function collectionLabelCollisionForce(getScale: () => number): GraphForce {
  let nodes: GraphCanvasNode[] = [];

  const force: GraphForce = () => {
    const scale = Math.max(0.1, getScale());
    const labels = nodes.filter((node): node is PositionedGraphCanvasNode => (
      node.kind === "collection" && hasNodePosition(node)
    ));
    if (labels.length < 2) return;

    const dimensions = new Map(
      labels.map((node) => {
        const box = collectionPillBox(node, scale);
        return [node.id, { width: box.width, height: box.height }];
      }),
    );
    const gap = COLLECTION_LABEL_GAP / scale;

    for (let iteration = 0; iteration < COLLECTION_LABEL_COLLISION_ITERATIONS; iteration += 1) {
      for (let index = 0; index < labels.length; index += 1) {
        for (let otherIndex = index + 1; otherIndex < labels.length; otherIndex += 1) {
          const a = labels[index];
          const b = labels[otherIndex];
          if (!a || !b) continue;

          const aDimensions = dimensions.get(a.id);
          const bDimensions = dimensions.get(b.id);
          if (!aDimensions || !bDimensions) continue;

          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const overlapX = (aDimensions.width + bDimensions.width) / 2 + gap - Math.abs(dx);
          const overlapY = (aDimensions.height + bDimensions.height) / 2 + gap - Math.abs(dy);
          if (overlapX <= 0 || overlapY <= 0) continue;

          if (overlapX <= overlapY) {
            separateLabelPair(a, b, "x", overlapX, separationSign(dx, a.id, b.id));
          } else {
            separateLabelPair(a, b, "y", overlapY, separationSign(dy, a.id, b.id));
          }
        }
      }
    }
  };

  force.initialize = (nextNodes) => {
    nodes = nextNodes;
  };

  return force;
}

function separateLabelPair(
  a: PositionedGraphCanvasNode,
  b: PositionedGraphCanvasNode,
  axis: "x" | "y",
  overlap: number,
  sign: -1 | 1,
) {
  const aPinned = isNodePinnedOnAxis(a, axis);
  const bPinned = isNodePinnedOnAxis(b, axis);
  if (aPinned && bPinned) return;

  if (aPinned) {
    moveCollisionNode(b, axis, sign * overlap);
    return;
  }
  if (bPinned) {
    moveCollisionNode(a, axis, -sign * overlap);
    return;
  }

  moveCollisionNode(a, axis, -sign * overlap / 2);
  moveCollisionNode(b, axis, sign * overlap / 2);
}

function moveCollisionNode(
  node: PositionedGraphCanvasNode,
  axis: "x" | "y",
  delta: number,
) {
  node[axis] += delta;
  const velocityAxis = axis === "x" ? "vx" : "vy";
  const currentVelocity = node[velocityAxis];
  if (typeof currentVelocity === "number" && Number.isFinite(currentVelocity)) {
    node[velocityAxis] = currentVelocity * 0.35;
  }
}

function isNodePinnedOnAxis(node: GraphCanvasNode, axis: "x" | "y"): boolean {
  const pinnedValue = axis === "x" ? node.fx : node.fy;
  return Number.isFinite(pinnedValue);
}

function separationSign(delta: number, idA: string, idB: string): -1 | 1 {
  if (delta < 0) return -1;
  if (delta > 0) return 1;
  return idA < idB ? 1 : -1;
}
