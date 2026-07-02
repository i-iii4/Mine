import { describe, expect, it } from "vitest";
import {
  computeFeedScrollReadinessWindows,
  sampleFeedScrollSignal,
} from "./feedScrollReadiness";

describe("computeFeedScrollReadinessWindows", () => {
  it("computes adaptive forward windows for normal downward scroll", () => {
    const windows = computeFeedScrollReadinessWindows({
      viewportHeight: 900,
      scrollVelocityPxMs: 0,
      scrollDirection: "forward",
      visibleItemCount: 20,
    });

    expect(windows).toMatchObject({
      renderBeforePx: 450,
      renderAfterPx: 720,
      priorityBeforePx: 990,
      priorityAfterPx: 3200,
      preloadBeforePx: 1600,
      preloadAfterPx: 4800,
      commitLookaheadBlocks: 48,
    });
  });

  it("expands render, priority and preload windows with scroll velocity", () => {
    const windows = computeFeedScrollReadinessWindows({
      viewportHeight: 1200,
      scrollVelocityPxMs: 5,
      scrollDirection: "forward",
      visibleItemCount: 40,
    });

    expect(windows.renderAfterPx).toBe(1300);
    // 5 px/ms * 350 = 1750 velocity contribution, quantized up to 1800.
    expect(windows.priorityAfterPx).toBe(5400);
    expect(windows.preloadAfterPx).toBe(7800);
    expect(windows.commitLookaheadBlocks).toBe(80);
  });

  it("mirrors forward budgets when scrolling backward", () => {
    const windows = computeFeedScrollReadinessWindows({
      viewportHeight: 900,
      scrollVelocityPxMs: 3,
      scrollDirection: "backward",
      visibleItemCount: 10,
    });

    expect(windows.renderBeforePx).toBeGreaterThan(windows.renderAfterPx);
    expect(windows.priorityBeforePx).toBeGreaterThan(windows.priorityAfterPx);
    expect(windows.preloadBeforePx).toBeGreaterThan(windows.preloadAfterPx);
  });

  it("clamps very large viewport and velocity values", () => {
    const windows = computeFeedScrollReadinessWindows({
      viewportHeight: 4000,
      scrollVelocityPxMs: 50,
      scrollDirection: "forward",
      visibleItemCount: 10,
    });

    expect(windows.renderAfterPx).toBe(1800);
    expect(windows.priorityAfterPx).toBe(8000);
    expect(windows.preloadAfterPx).toBe(14000);
    expect(windows.preloadBeforePx).toBe(3600);
  });

  it("quantizes velocity growth so nearby velocities produce identical windows", () => {
    const at = (velocity: number) =>
      computeFeedScrollReadinessWindows({
        viewportHeight: 900,
        scrollVelocityPxMs: velocity,
        scrollDirection: "forward",
        visibleItemCount: 20,
      });

    // 0.1 and 0.2 px/ms: every velocity contribution lands in the first 200 px
    // bucket, so the full window set is identical.
    expect(at(0.2)).toEqual(at(0.1));

    // The render window shares one 200 px bucket across a broad velocity range
    // (contribution = v * 80, below 200 px for any v < 2.5). This is what keeps
    // getVisibleItems identity stable frame-to-frame during steady scrolling.
    expect(at(2.0).renderAfterPx).toBe(at(1.0).renderAfterPx);

    // Crossing into the next render bucket widens the render window.
    expect(at(3.0).renderAfterPx).toBeGreaterThan(at(2.0).renderAfterPx);
  });

  it("never narrows a window below its unquantized value", () => {
    const vh = 1000;
    for (const velocity of [0, 0.4, 0.9, 1.7, 2.6, 4.3]) {
      const windows = computeFeedScrollReadinessWindows({
        viewportHeight: vh,
        scrollVelocityPxMs: velocity,
        scrollDirection: "forward",
        visibleItemCount: 20,
      });
      const rawRenderAfter = Math.round(
        Math.min(Math.max(Math.max(720, vh * 0.75 + velocity * 80), 640), 1800),
      );
      const rawPriorityAfter = Math.round(
        Math.min(Math.max(vh * 3 + velocity * 350, 3200), 8000),
      );
      const rawPreloadAfter = Math.round(
        Math.min(Math.max(vh * 4 + velocity * 600, 4800), 14000),
      );
      expect(windows.renderAfterPx).toBeGreaterThanOrEqual(rawRenderAfter);
      expect(windows.priorityAfterPx).toBeGreaterThanOrEqual(rawPriorityAfter);
      expect(windows.preloadAfterPx).toBeGreaterThanOrEqual(rawPreloadAfter);
    }
  });

  it("keeps the backward render window at or above half the viewport (linger contract)", () => {
    for (const vh of [600, 900, 1200]) {
      const windows = computeFeedScrollReadinessWindows({
        viewportHeight: vh,
        scrollVelocityPxMs: 0,
        scrollDirection: "forward",
        visibleItemCount: 20,
      });
      // Scrolling forward, the backward window is exposed as renderBeforePx.
      expect(windows.renderBeforePx).toBeGreaterThanOrEqual(vh * 0.5);
      // Priority and preload backward windows share the same lower bound.
      expect(windows.priorityBeforePx).toBeGreaterThanOrEqual(vh * 0.5);
      expect(windows.preloadBeforePx).toBeGreaterThanOrEqual(vh * 0.5);
    }
  });
});

describe("sampleFeedScrollSignal", () => {
  it("samples initial idle state", () => {
    const { sample, signal } = sampleFeedScrollSignal({
      previous: null,
      scrollTop: 100,
      timeMs: 10,
    });

    expect(sample.scrollTop).toBe(100);
    expect(signal.scrollDirection).toBe("idle");
    expect(signal.scrollVelocityPxMs).toBe(0);
  });

  it("tracks direction and smoothed velocity", () => {
    const first = sampleFeedScrollSignal({
      previous: null,
      scrollTop: 0,
      timeMs: 0,
    });
    const second = sampleFeedScrollSignal({
      previous: first.sample,
      scrollTop: 160,
      timeMs: 16,
    });

    expect(second.signal.scrollDirection).toBe("forward");
    expect(second.signal.scrollVelocityPxMs).toBe(3);
    expect(second.signal.isFastScrolling).toBe(true);
  });

  it("uses hysteresis before leaving fast-scroll mode", () => {
    const stillFast = sampleFeedScrollSignal({
      previous: {
        scrollTop: 100,
        timeMs: 10,
        scrollVelocityPxMs: 2,
        isFastScrolling: true,
      },
      scrollTop: 100,
      timeMs: 26,
    });
    const slow = sampleFeedScrollSignal({
      previous: {
        scrollTop: 100,
        timeMs: 10,
        scrollVelocityPxMs: 1.1,
        isFastScrolling: true,
      },
      scrollTop: 100,
      timeMs: 26,
    });
    const notEntered = sampleFeedScrollSignal({
      previous: {
        scrollTop: 100,
        timeMs: 10,
        scrollVelocityPxMs: 1.3,
        isFastScrolling: false,
      },
      scrollTop: 100,
      timeMs: 26,
    });

    expect(stillFast.signal.isFastScrolling).toBe(true);
    expect(slow.signal.isFastScrolling).toBe(false);
    expect(notEntered.signal.isFastScrolling).toBe(false);
  });

  it("leaves fast-scroll mode when smoothed velocity drops below the exit threshold", () => {
    const previous = {
      scrollTop: 100,
      timeMs: 10,
      scrollVelocityPxMs: 2.8,
      isFastScrolling: true,
    };
    let sample = sampleFeedScrollSignal({
      previous,
      scrollTop: 100,
      timeMs: 26,
    }).sample;
    sample = sampleFeedScrollSignal({ previous: sample, scrollTop: 100, timeMs: 42 }).sample;
    const slow = sampleFeedScrollSignal({ previous: sample, scrollTop: 100, timeMs: 58 });

    expect(slow.signal.isFastScrolling).toBe(false);
  });
});
