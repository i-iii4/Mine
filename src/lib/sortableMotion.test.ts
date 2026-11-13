import { describe, expect, it } from "vitest";
import { MOTION_ENTER_MS, MOTION_MOVE_EASE, MOTION_MOVE_MS } from "./motion";
import { setMotionLevel } from "@/test/motionLevel";
import { sortableMove } from "./sortableMotion";

// SPEC_MOTION_LEVELS.md, М8: the spaces in Settings, the sidebar's columns,
// the cards of Merge make room as Перемещение (РД1): 200 ms in Full on the
// move curve (was dnd-kit's own `ease`, РД7), 150 ms in Minimal.
describe("sortableMove", () => {
  it("moves as Перемещение in Full", () => {
    expect(sortableMove(false)).toEqual({ duration: MOTION_MOVE_MS, easing: MOTION_MOVE_EASE });
    expect(MOTION_MOVE_MS).toBe(200);
  });

  it("moves in 150 ms on the move curve at Minimal", () => {
    setMotionLevel("minimal");
    expect(sortableMove(false)).toEqual({ duration: MOTION_ENTER_MS, easing: MOTION_MOVE_EASE });
  });

  it("stands the rows in place at once at Off", () => {
    setMotionLevel("off");
    expect(sortableMove(false)).toBeNull();
  });

  it("stands them at once at every level when the keyboard reorders (УД4)", () => {
    for (const level of ["full", "minimal", "off"] as const) {
      setMotionLevel(level);
      expect(sortableMove(true)).toBeNull();
    }
  });
});
