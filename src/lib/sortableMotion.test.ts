import { describe, expect, it } from "vitest";
import { MOTION_LEVELS, MOTION_MOVE_EASE, MOTION_MOVE_MS } from "./motion";
import { setMotionLevel } from "@/test/motionLevel";
import { sortableMove } from "./sortableMotion";

// SPEC_MOTION_LEVELS.md, М8: the spaces in Settings, the sidebar's columns,
// the cards of Merge make room as Перемещение (РД1): 200 ms on the move
// curve. The rows answer a drag in hand, so they move the same in every mode
// («Режимы»; user's decision of 13.11.2026).
describe("sortableMove", () => {
  it.each(MOTION_LEVELS)("moves as Перемещение at %s", (level) => {
    setMotionLevel(level);
    expect(sortableMove(false)).toEqual({ duration: MOTION_MOVE_MS, easing: MOTION_MOVE_EASE });
    expect(MOTION_MOVE_MS).toBe(200);
  });

  it("stands them at once in every mode when the keyboard reorders (УД4)", () => {
    for (const level of MOTION_LEVELS) {
      setMotionLevel(level);
      expect(sortableMove(true)).toBeNull();
    }
  });
});
