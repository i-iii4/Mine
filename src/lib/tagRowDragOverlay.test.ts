import { describe, expect, it } from "vitest";
import { MOTION_LEVELS, MOTION_MOVE_EASE, MOTION_MOVE_MS } from "@/lib/motion";
import { setMotionLevel } from "@/test/motionLevel";
import { tagRowDropAnimation, tagRowSortTransition } from "./tagRowDragOverlay";

// dnd-kit plays the drop and the neighbours' parting through Web Animations
// and inline transitions, so both ask motion.ts for their time
// (SPEC_MOTION_LEVELS.md, С9, Р2). Both are Перемещение (РД1): 200 ms on the
// move curve. They answer a drag in hand, so they are the same in every mode
// («Режимы»; user's decision of 13.11.2026).
describe("collection row drop flight (SPEC_MOTION_LEVELS.md, С9)", () => {
  it.each(MOTION_LEVELS)("flies into the open slot as Перемещение at %s", (level) => {
    setMotionLevel(level);
    expect(tagRowDropAnimation()).toMatchObject({ duration: MOTION_MOVE_MS, easing: MOTION_MOVE_EASE });
    expect(MOTION_MOVE_MS).toBe(200);
  });
});

describe("collection rows parting for the dragged one (SPEC_MOTION_LEVELS.md, С9)", () => {
  it.each(MOTION_LEVELS)("moves the neighbours as the drop does at %s: 200 ms on the move curve", (level) => {
    setMotionLevel(level);
    expect(tagRowSortTransition()).toEqual({ duration: MOTION_MOVE_MS, easing: MOTION_MOVE_EASE });
  });
});
