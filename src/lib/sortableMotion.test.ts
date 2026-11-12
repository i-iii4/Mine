import { describe, expect, it } from "vitest";
import { MOTION_EASE } from "./motion";
import { setMotionLevel } from "@/test/motionLevel";
import { sortableMove, SORTABLE_MOVE_EASING, SORTABLE_MOVE_MS } from "./sortableMotion";

// SPEC_MOTION_LEVELS.md, М8: the spaces in Settings, the sidebar's columns,
// the cards of Merge make room by the level.
describe("sortableMove", () => {
  it("keeps dnd-kit's own move in Full", () => {
    expect(SORTABLE_MOVE_MS).toBe(200);
    expect(SORTABLE_MOVE_EASING).toBe("ease");
    expect(sortableMove(false)).toEqual({ duration: 200, easing: "ease" });
  });

  it("moves in 150 ms on E at Minimal", () => {
    setMotionLevel("minimal");
    expect(sortableMove(false)).toEqual({ duration: 150, easing: MOTION_EASE });
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
