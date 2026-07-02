export type FeedScrollDirection = "forward" | "backward" | "idle";

export interface FeedScrollSignal {
  scrollTop: number;
  scrollDirection: FeedScrollDirection;
  scrollVelocityPxMs: number;
  isFastScrolling: boolean;
}

export interface FeedScrollSignalSample {
  scrollTop: number;
  timeMs: number;
  scrollVelocityPxMs: number;
  isFastScrolling: boolean;
}

export interface FeedScrollReadinessWindows {
  renderBeforePx: number;
  renderAfterPx: number;
  priorityBeforePx: number;
  priorityAfterPx: number;
  preloadBeforePx: number;
  preloadAfterPx: number;
  commitLookaheadBlocks: number;
}

export const FEED_FAST_SCROLL_ENTER_VELOCITY_PX_MS = 2.4;
export const FEED_FAST_SCROLL_EXIT_VELOCITY_PX_MS = 1.2;
export const FEED_SCROLL_VELOCITY_ALPHA = 0.3;
export const FEED_RENDER_RUNWAY_MIN_FORWARD_PX = 720;
export const FEED_RENDER_RUNWAY_MAX_FORWARD_PX = 1800;
// Velocity-dependent window growth is quantized to this step so the window
// identity stays stable across consecutive animation frames while the smoothed
// velocity drifts. Without quantization every scroll frame produces a slightly
// different renderAfterPx, which re-creates the getVisibleItems callback and
// forces a redundant Grid re-render even when the visible set is unchanged.
export const FEED_SCROLL_WINDOW_VELOCITY_QUANTUM_PX = 200;
// Backward render runway floor as a fraction of the viewport. It guarantees the
// window behind the scroll cursor never drops below the linger contract
// (SPEC_FEED_VIDEO.md: keep already-committed cards mounted when the scroll
// direction reverses).
export const FEED_RENDER_RUNWAY_BACKWARD_VIEWPORT_RATIO = 0.5;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

// Round a velocity-driven window contribution UP to the quantum. Rounding up
// (never down) guarantees the quantized window is always at least as wide as
// the raw value, so quantization can never narrow a window below what the
// continuous formula would produce.
function quantizeVelocityContribution(px: number): number {
  if (!Number.isFinite(px) || px <= 0) return 0;
  return (
    Math.ceil(px / FEED_SCROLL_WINDOW_VELOCITY_QUANTUM_PX) *
    FEED_SCROLL_WINDOW_VELOCITY_QUANTUM_PX
  );
}

function safeViewportHeight(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function safeVelocity(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function orientWindow(
  direction: FeedScrollDirection,
  backwardPx: number,
  forwardPx: number,
): { beforePx: number; afterPx: number } {
  return direction === "backward"
    ? { beforePx: forwardPx, afterPx: backwardPx }
    : { beforePx: backwardPx, afterPx: forwardPx };
}

export function computeFeedScrollReadinessWindows({
  viewportHeight,
  scrollVelocityPxMs,
  scrollDirection,
  visibleItemCount,
}: {
  viewportHeight: number;
  scrollVelocityPxMs: number;
  scrollDirection: FeedScrollDirection;
  visibleItemCount: number;
}): FeedScrollReadinessWindows {
  const vh = safeViewportHeight(viewportHeight);
  const velocity = safeVelocity(scrollVelocityPxMs);

  const renderForwardPx = clamp(
    Math.max(
      FEED_RENDER_RUNWAY_MIN_FORWARD_PX,
      vh * 0.75 + quantizeVelocityContribution(velocity * 80),
    ),
    640,
    FEED_RENDER_RUNWAY_MAX_FORWARD_PX,
  );
  // Backward runway floor honors the linger contract: keep at least half a
  // viewport of already-committed cards mounted behind the scroll cursor so a
  // direction reversal never lands on an unmounted (blank) region. The 800px
  // cap keeps backward DOM bounded; it holds the >= 0.5 * vh floor for every
  // viewport up to 1600px, which covers the full realistic desktop feed range.
  const renderBackwardPx = clamp(
    Math.max(360, vh * FEED_RENDER_RUNWAY_BACKWARD_VIEWPORT_RATIO),
    320,
    800,
  );
  const priorityForwardPx = clamp(
    vh * 3 + quantizeVelocityContribution(velocity * 350),
    3200,
    8000,
  );
  // priorityBackward (1.1 * vh) and preloadBackward (1.5 * vh) already sit above
  // the 0.5 * vh backward floor, so the render window is the only one that
  // needed raising to satisfy the linger contract consistently.
  const priorityBackwardPx = clamp(vh * 1.1, 800, 2400);
  const preloadForwardPx = clamp(
    vh * 4 + quantizeVelocityContribution(velocity * 600),
    4800,
    14000,
  );
  const preloadBackwardPx = clamp(vh * 1.5, 1600, 3600);

  const render = orientWindow(scrollDirection, renderBackwardPx, renderForwardPx);
  const priority = orientWindow(scrollDirection, priorityBackwardPx, priorityForwardPx);
  const preload = orientWindow(scrollDirection, preloadBackwardPx, preloadForwardPx);

  return {
    renderBeforePx: Math.round(render.beforePx),
    renderAfterPx: Math.round(render.afterPx),
    priorityBeforePx: Math.round(priority.beforePx),
    priorityAfterPx: Math.round(priority.afterPx),
    preloadBeforePx: Math.round(preload.beforePx),
    preloadAfterPx: Math.round(preload.afterPx),
    commitLookaheadBlocks: Math.max(48, Math.max(0, visibleItemCount) * 2),
  };
}

export function sampleFeedScrollSignal({
  previous,
  scrollTop,
  timeMs,
}: {
  previous: FeedScrollSignalSample | null;
  scrollTop: number;
  timeMs: number;
}): { sample: FeedScrollSignalSample; signal: FeedScrollSignal } {
  if (!previous) {
    const sample = {
      scrollTop,
      timeMs,
      scrollVelocityPxMs: 0,
      isFastScrolling: false,
    };
    return {
      sample,
      signal: {
        scrollTop,
        scrollDirection: "idle",
        scrollVelocityPxMs: 0,
        isFastScrolling: false,
      },
    };
  }

  const deltaPx = scrollTop - previous.scrollTop;
  const elapsedMs = Math.max(1, timeMs - previous.timeMs);
  const instantVelocity = Math.abs(deltaPx) / elapsedMs;
  const scrollVelocityPxMs =
    previous.scrollVelocityPxMs * (1 - FEED_SCROLL_VELOCITY_ALPHA) +
    instantVelocity * FEED_SCROLL_VELOCITY_ALPHA;
  const scrollDirection: FeedScrollDirection =
    deltaPx > 0.5 ? "forward" : deltaPx < -0.5 ? "backward" : "idle";
  const isFastScrolling = previous.isFastScrolling
    ? scrollVelocityPxMs >= FEED_FAST_SCROLL_EXIT_VELOCITY_PX_MS
    : scrollVelocityPxMs >= FEED_FAST_SCROLL_ENTER_VELOCITY_PX_MS;
  const sample = {
    scrollTop,
    timeMs,
    scrollVelocityPxMs,
    isFastScrolling,
  };

  return {
    sample,
    signal: {
      scrollTop,
      scrollDirection,
      scrollVelocityPxMs,
      isFastScrolling,
    },
  };
}
