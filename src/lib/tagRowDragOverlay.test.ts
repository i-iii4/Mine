import { describe, expect, it } from "vitest";
import { MOTION_ENTER_MS, MOTION_MOVE_EASE, MOTION_MOVE_MS } from "@/lib/motion";
import { setMotionLevel } from "@/test/motionLevel";
import { tagRowDropAnimation, tagRowSortTransition } from "./tagRowDragOverlay";

// dnd-kit plays the drop and the neighbours' parting through Web Animations
// and inline transitions, which no CSS rule of the level reaches: both ask
// the level themselves (SPEC_MOTION_LEVELS.md, С9, Р2). Both are Перемещение
// (РД1): one time and the move curve, 200 ms in Full (was 200 ms on E and
// 250 ms `ease`, РД7), 150 ms in Minimal.
describe("collection row drop flight (SPEC_MOTION_LEVELS.md, С9)", () => {
  it("flies into the open slot as Перемещение in Full", () => {
    expect(tagRowDropAnimation()).toMatchObject({ duration: MOTION_MOVE_MS, easing: MOTION_MOVE_EASE });
    expect(MOTION_MOVE_MS).toBe(200);
  });

  it("flies for 150 ms on the move curve in Minimal", () => {
    setMotionLevel("minimal");
    expect(tagRowDropAnimation()).toMatchObject({ duration: MOTION_ENTER_MS, easing: MOTION_MOVE_EASE });
  });

  it("does not fly in Off: the row lands where it is dropped", () => {
    setMotionLevel("off");
    expect(tagRowDropAnimation()).toBeNull();
  });
});

describe("collection rows parting for the dragged one (SPEC_MOTION_LEVELS.md, С9)", () => {
  it("moves the neighbours as the drop does in Full: 200 ms on the move curve", () => {
    expect(tagRowSortTransition()).toEqual({ duration: MOTION_MOVE_MS, easing: MOTION_MOVE_EASE });
  });

  it("moves them for 150 ms on the move curve in Minimal", () => {
    setMotionLevel("minimal");
    expect(tagRowSortTransition()).toEqual({ duration: MOTION_ENTER_MS, easing: MOTION_MOVE_EASE });
  });

  it("stands them at once in Off", () => {
    setMotionLevel("off");
    expect(tagRowSortTransition()).toBeNull();
  });
});
