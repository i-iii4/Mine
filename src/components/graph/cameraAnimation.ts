// A camera movement of the graph that a gesture can stop.
//
// The graph library animates its camera with its own tween and offers no way
// to stop it: a wheel or a drag in the middle of a glide was overwritten on
// the next frame. Here the glide is ours, one frame at a time, and cancelling
// it leaves the camera where it is on screen (SPEC_AUDIT_FIXES.md, Ф12, А5.2).

export interface CameraGraph {
  centerAt(): { x: number; y: number };
  centerAt(x: number, y: number, ms?: number): unknown;
  zoom(): number;
  zoom(k: number, ms?: number): unknown;
}

export interface CameraTarget {
  x: number;
  y: number;
  /** A new zoom, or `null` to keep the current one. */
  k: number | null;
}

type Frame = (callback: FrameRequestCallback) => number;
type CancelFrame = (handle: number) => void;

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/**
 * Glide the camera to `target` over `durationMs` and return a function that
 * stops the glide where it is. A zero duration places the camera at once.
 */
export function animateCamera(
  graph: CameraGraph,
  target: CameraTarget,
  durationMs: number,
  frame: Frame = window.requestAnimationFrame.bind(window),
  cancelFrame: CancelFrame = window.cancelAnimationFrame.bind(window),
  now: () => number = () => performance.now(),
): () => void {
  const from = graph.centerAt();
  const fromK = graph.zoom();
  const place = (t: number) => {
    const eased = easeOutCubic(t);
    graph.centerAt(from.x + (target.x - from.x) * eased, from.y + (target.y - from.y) * eased, 0);
    if (target.k !== null) graph.zoom(fromK + (target.k - fromK) * eased, 0);
  };
  if (durationMs <= 0) {
    place(1);
    return () => undefined;
  }
  const start = now();
  let handle: number | null = null;
  const step = () => {
    const t = Math.min(1, (now() - start) / durationMs);
    place(t);
    handle = t < 1 ? frame(step) : null;
  };
  handle = frame(step);
  return () => {
    if (handle !== null) cancelFrame(handle);
    handle = null;
  };
}
