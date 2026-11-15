// The glide of a tooltip to its neighbour (SPEC_MOTION_LEVELS.md, М3; user's
// decision of 15.11.2026): what a group is, and the way one glide goes, by
// its values alone. The page's side lives in src/components/ui/tooltip.test.tsx.

import { describe, expect, it } from "vitest";
import { SPRING_RESPONSE_S } from "./channelIcon";
import { HOVER_PREVIEW_WINDOW_SETTLE_MS } from "./hoverPreviewWindow";
import { MOTION_ENTER_MS, MOTION_EXIT_MS, type MotionLevel } from "./motion";
import {
  TOOLTIP_GLIDE_SETTLE_MS,
  TooltipGlideMotion,
  onOneLine,
  sameTooltipGroup,
  type GlideBox,
} from "./tooltipGlide";
import { setMotionLevel } from "@/test/motionLevel";

const FRAME_MS = 1000 / 60;
const AT_REST = { x: 0, y: 0, width: 0, height: 0 };

/** The share of its way a critically damped spring of the stack's response
 *  has gone at `ms`. */
function springShare(ms: number): number {
  const omega = (2 * Math.PI) / SPRING_RESPONSE_S;
  const t = ms / 1000;
  return 1 - (1 + omega * t) * Math.exp(-omega * t);
}

function place(element: Element, box: { left: number; top: number; width: number; height: number }): void {
  element.getBoundingClientRect = () => DOMRect.fromRect({ x: box.left, y: box.top, width: box.width, height: box.height });
}

describe("a tooltip's group", () => {
  it("is one line when each button's middle lies within the other", () => {
    expect(onOneLine({ top: 0, bottom: 32 }, { top: 4, bottom: 28 })).toBe(true);
    // A row that wrapped: the second line's button stands under the first.
    expect(onOneLine({ top: 0, bottom: 32 }, { top: 36, bottom: 68 })).toBe(false);
    expect(onOneLine({ top: 0, bottom: 32 }, { top: 20, bottom: 52 })).toBe(false);
  });

  it("is the buttons of one container on one line, never a button and itself", () => {
    const row = document.createElement("div");
    const other = document.createElement("div");
    const [a, b, c, d] = ["a", "b", "c", "d"].map(() => document.createElement("button"));
    row.append(a!, b!, d!);
    other.append(c!);
    place(a!, { left: 0, top: 0, width: 32, height: 32 });
    place(b!, { left: 72, top: 0, width: 32, height: 32 });
    place(c!, { left: 120, top: 0, width: 32, height: 32 });
    place(d!, { left: 0, top: 40, width: 32, height: 32 });
    expect(sameTooltipGroup(a!, b!)).toBe(true);
    expect(sameTooltipGroup(a!, c!)).toBe(false);
    expect(sameTooltipGroup(a!, d!)).toBe(false);
    expect(sameTooltipGroup(a!, a!)).toBe(false);
    expect(sameTooltipGroup(null, b!)).toBe(false);
  });
});

describe("the way of one glide", () => {
  const from: GlideBox = { x: 4, y: 40, width: 72, height: 26 };
  const to: GlideBox = { x: 82, y: 40, width: 64, height: 26 };

  it("takes the preview window's spring: one kind of motion, one value («Отношения системы», 3)", () => {
    expect(TOOLTIP_GLIDE_SETTLE_MS).toBe(HOVER_PREVIEW_WINDOW_SETTLE_MS);
  });

  it.each<MotionLevel>(["full", "minimal", "off"])(
    "goes from the old place and width to the new on the spring, the same at %s (Р1)",
    (level) => {
      setMotionLevel(level);
      const motion = new TooltipGlideMotion(to, from, AT_REST, 1, [1]);
      expect(motion.box()).toEqual(from);
      let elapsed = 0;
      let previous = motion.box();
      while (!motion.settled()) {
        motion.step(FRAME_MS);
        elapsed += FRAME_MS;
        const box = motion.box();
        if (elapsed < TOOLTIP_GLIDE_SETTLE_MS) {
          expect((box.x - from.x) / (to.x - from.x)).toBeCloseTo(springShare(elapsed), 9);
          expect((box.width - from.width) / (to.width - from.width)).toBeCloseTo(springShare(elapsed), 9);
        }
        // Monotonic: never back, never past.
        expect(box.x).toBeGreaterThanOrEqual(previous.x);
        expect(box.x).toBeLessThanOrEqual(to.x);
        expect(box.width).toBeLessThanOrEqual(previous.width);
        expect(box.width).toBeGreaterThanOrEqual(to.width);
        previous = box;
      }
      expect(motion.box()).toEqual(to);
      expect(elapsed).toBeGreaterThanOrEqual(TOOLTIP_GLIDE_SETTLE_MS);
      expect(elapsed).toBeLessThan(TOOLTIP_GLIDE_SETTLE_MS + FRAME_MS);
    },
  );

  it.each<MotionLevel>(["full", "minimal", "off"])(
    "brings the new text on Отклик's enter and takes the old on its exit, from where they stand, at %s",
    (level) => {
      setMotionLevel(level);
      const motion = new TooltipGlideMotion(to, from, AT_REST, 0.6, [1, 0.4]);
      expect(motion.incoming.value).toBe(0);
      expect(motion.surface.value).toBe(0.6);
      expect(motion.outgoing.map((fade) => fade.value)).toEqual([1, 0.4]);
      motion.step(MOTION_EXIT_MS);
      expect(motion.outgoing.map((fade) => fade.value)).toEqual([0, 0]);
      expect(motion.incoming.value).toBeCloseTo(MOTION_EXIT_MS / MOTION_ENTER_MS, 9);
      motion.step(MOTION_ENTER_MS - MOTION_EXIT_MS);
      expect(motion.incoming.value).toBe(1);
      expect(motion.surface.value).toBe(1);
    },
  );

  it("turns to a third button from where the frame stands, at the speed it has", () => {
    const first = new TooltipGlideMotion(to, from, AT_REST, 1, [1]);
    for (let index = 0; index < 4; index += 1) first.step(FRAME_MS);
    const third: GlideBox = { x: 150, y: 40, width: 120, height: 26 };
    const turn = new TooltipGlideMotion(third, first.box(), first.velocity(), 1, [1]);
    // No jump: the new glide starts where the frame stood.
    expect(turn.box()).toEqual(first.box());
    // No break of speed: the new glide leaves at the speed the old one had.
    const before = first.box().x;
    const instantMs = 0.01;
    turn.step(instantMs);
    const speedPerS = ((turn.box().x - before) / instantMs) * 1000;
    expect(first.velocity().x).toBeGreaterThan(0);
    expect(Math.abs(speedPerS - first.velocity().x) / first.velocity().x).toBeLessThan(1e-3);
  });
});
