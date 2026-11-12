import { describe, expect, it } from "vitest";
import { MOTION_EASE, MOTION_ENTER_MS } from "@/lib/motion";
import { setMotionLevel } from "@/test/motionLevel";
import {
  TAG_ROW_DROP_EASING,
  TAG_ROW_DROP_MS,
  TAG_ROW_SORT_EASING,
  TAG_ROW_SORT_MS,
  tagRowDropAnimation,
  tagRowSortTransition,
} from "./tagRowDragOverlay";

// dnd-kit plays the drop and the neighbours' parting through Web Animations
// and inline transitions, which no CSS rule of the level reaches: both ask
// the level themselves (SPEC_MOTION_LEVELS.md, С9, Р2).
describe("collection row drop flight (SPEC_MOTION_LEVELS.md, С9)", () => {
  it("flies into the open slot for 200 ms on E in Full", () => {
    expect(tagRowDropAnimation()).toMatchObject({ duration: TAG_ROW_DROP_MS, easing: TAG_ROW_DROP_EASING });
    expect(TAG_ROW_DROP_MS).toBe(200);
    expect(TAG_ROW_DROP_EASING).toBe(MOTION_EASE);
  });

  it("flies for 150 ms on E in Minimal", () => {
    setMotionLevel("minimal");
    expect(tagRowDropAnimation()).toMatchObject({ duration: MOTION_ENTER_MS, easing: MOTION_EASE });
  });

  it("does not fly in Off: the row lands where it is dropped", () => {
    setMotionLevel("off");
    expect(tagRowDropAnimation()).toBeNull();
  });
});

describe("collection rows parting for the dragged one (SPEC_MOTION_LEVELS.md, С9)", () => {
  it("moves the neighbours for 250 ms on ease in Full, dnd-kit's own", () => {
    expect(tagRowSortTransition()).toEqual({ duration: TAG_ROW_SORT_MS, easing: TAG_ROW_SORT_EASING });
    expect(TAG_ROW_SORT_MS).toBe(250);
    expect(TAG_ROW_SORT_EASING).toBe("ease");
  });

  it("moves them for 150 ms on E in Minimal", () => {
    setMotionLevel("minimal");
    expect(tagRowSortTransition()).toEqual({ duration: MOTION_ENTER_MS, easing: MOTION_EASE });
  });

  it("stands them at once in Off", () => {
    setMotionLevel("off");
    expect(tagRowSortTransition()).toBeNull();
  });
});
