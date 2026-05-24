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
      renderBeforePx: 1000,
      renderAfterPx: 3600,
      priorityBeforePx: 990,
      priorityAfterPx: 3200,
      preloadBeforePx: 1600,
      preloadAfterPx: 4800,
      commitLookaheadBlocks: 48,
    });
  });

  it("expands priority and preload windows with scroll velocity", () => {
    const windows = computeFeedScrollReadinessWindows({
      viewportHeight: 1200,
      scrollVelocityPxMs: 5,
      scrollDirection: "forward",
      visibleItemCount: 40,
    });

    expect(windows.priorityAfterPx).toBe(5350);
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

    expect(windows.renderAfterPx).toBe(5200);
    expect(windows.priorityAfterPx).toBe(8000);
    expect(windows.preloadAfterPx).toBe(14000);
    expect(windows.preloadBeforePx).toBe(3600);
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
