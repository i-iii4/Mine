import { afterEach, describe, expect, it, vi } from "vitest";
import { peekPoseAt, peekPoseKeyframes, PEEK_POSE_REST, PEEK_POSE_RISE_FROM, PEEK_POSE_SUNK } from "./cardPeek";
import { MOTION_EASE } from "./motion";
import { createPoseRunner } from "./poseMotion";

/** Animations of the page, heard, each with a clock set by hand. */
function hearAnimations() {
  const heard: { element: Element; keyframes: Keyframe[]; timing: KeyframeAnimationOptions; animation: { currentTime: number; startTime: number | null; onfinish: (() => void) | null; cancel: ReturnType<typeof vi.fn> } }[] = [];
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value(this: HTMLElement, keyframes: Keyframe[], timing: KeyframeAnimationOptions) {
      const animation = { currentTime: 0, startTime: null as number | null, onfinish: null as (() => void) | null, cancel: vi.fn() };
      heard.push({ element: this, keyframes, timing, animation });
      return animation;
    },
  });
  return heard;
}

afterEach(() => {
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
  vi.unstubAllGlobals();
});

describe("Minimal's motion of a window (SPEC_MOTION_LEVELS.md, ОУ2–ОУ5, ОУ9)", () => {
  const targets = () => {
    const part = document.createElement("div");
    const island = document.createElement("div");
    const scrim = document.createElement("div");
    return { part, island, scrim, targets: { parts: [part, island], scrim } };
  };

  it("moves each part by one transform and one opacity, the scrim by its opacity, on E", () => {
    const heard = hearAnimations();
    const { part, island, scrim, targets: moving } = targets();
    const runner = createPoseRunner<"rise">();
    runner.move("rise", PEEK_POSE_RISE_FROM, PEEK_POSE_REST, 150, moving, vi.fn());
    const timing = { duration: 150, easing: MOTION_EASE, fill: "forwards" };
    const window = [peekPoseKeyframes(PEEK_POSE_RISE_FROM).window, peekPoseKeyframes(PEEK_POSE_REST).window];
    expect(heard.map(({ element, keyframes, timing: heardTiming }) => ({ element, keyframes, heardTiming }))).toEqual([
      { element: part, keyframes: window, heardTiming: timing },
      { element: island, keyframes: window, heardTiming: timing },
      { element: scrim, keyframes: [{ opacity: 0 }, { opacity: 1 }], heardTiming: timing },
    ]);
    expect(runner.motion()?.purpose).toBe("rise");
    expect(runner.target()).toBe(PEEK_POSE_REST);
  });

  it("starts the next motion where the window stands, the old one taken off", () => {
    const heard = hearAnimations();
    const { targets: moving } = targets();
    const runner = createPoseRunner<"rise" | "sink">();
    runner.move("rise", PEEK_POSE_RISE_FROM, PEEK_POSE_REST, 150, moving, vi.fn());
    heard[0]!.animation.currentTime = 60;
    const midway = peekPoseAt({ from: PEEK_POSE_RISE_FROM, to: PEEK_POSE_REST, duration: 150 }, 60);
    expect(runner.current()).toEqual(midway);
    runner.move("sink", null, PEEK_POSE_SUNK, 100, moving, vi.fn());
    for (const motion of heard.slice(0, 3)) expect(motion.animation.cancel).toHaveBeenCalled();
    expect(heard[3]!.keyframes).toEqual([peekPoseKeyframes(midway).window, peekPoseKeyframes(PEEK_POSE_SUNK).window]);
  });

  it("starts its clock at the frame the page showed last", () => {
    const heard = hearAnimations();
    Object.defineProperty(document, "timeline", { configurable: true, value: { currentTime: 1234 } });
    try {
      const { targets: moving } = targets();
      createPoseRunner<"sink">().move("sink", PEEK_POSE_REST, PEEK_POSE_SUNK, 100, moving, vi.fn());
      expect(heard.map(({ animation }) => animation.startTime)).toEqual([1234, 1234, 1234]);
    } finally {
      delete (document as { timeline?: unknown }).timeline;
    }
  });

  it("hears its end once, holds the end on the page, and counts every motion and stop", () => {
    const heard = hearAnimations();
    const { targets: moving } = targets();
    const runner = createPoseRunner<"sink">();
    const ended = vi.fn();
    const before = runner.generation();
    runner.move("sink", PEEK_POSE_REST, PEEK_POSE_SUNK, 100, moving, ended);
    expect(runner.generation()).toBeGreaterThan(before);
    const moved = runner.generation();
    heard[0]!.animation.currentTime = 100;
    heard[0]!.animation.onfinish?.();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(runner.motion()).toBeNull();
    expect(runner.active()).toBe(true);
    expect(runner.current()).toEqual(PEEK_POSE_SUNK);
    expect(runner.generation()).toBe(moved);
    runner.stop(true);
    expect(runner.active()).toBe(false);
    expect(runner.current()).toEqual(PEEK_POSE_REST);
    expect(runner.generation()).toBeGreaterThan(moved);
  });

  it("ends at once with no animations on the page", () => {
    const { targets: moving } = targets();
    const runner = createPoseRunner<"sink">();
    const ended = vi.fn();
    runner.move("sink", PEEK_POSE_REST, PEEK_POSE_SUNK, 100, moving, ended);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(runner.target()).toBe(PEEK_POSE_SUNK);
  });
});
