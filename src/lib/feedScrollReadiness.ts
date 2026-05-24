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

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
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
    Math.max(FEED_RENDER_RUNWAY_MIN_FORWARD_PX, vh * 0.75 + velocity * 80),
    640,
    FEED_RENDER_RUNWAY_MAX_FORWARD_PX,
  );
  const renderBackwardPx = clamp(Math.max(360, vh * 0.35), 320, 800);
  const priorityForwardPx = clamp(vh * 3 + velocity * 350, 3200, 8000);
  const priorityBackwardPx = clamp(vh * 1.1, 800, 2400);
  const preloadForwardPx = clamp(vh * 4 + velocity * 600, 4800, 14000);
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
