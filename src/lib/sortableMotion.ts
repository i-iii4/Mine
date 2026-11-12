// src/lib/sortableMotion.ts: how the rows of a reorderable list make room
// (SPEC_MOTION_LEVELS.md, М8): the spaces in Settings, the sidebar's columns
// menu, the cards of Merge. One value for the three lists, by the level.

import { useDndContext } from "@dnd-kit/core";
import type { UseSortableArguments } from "@dnd-kit/sortable";
import { motionEasing, motionMs, useMotionLevel } from "@/lib/motion";

/** What `useSortable` takes as its rows' move: a time and a curve, or none. */
export type SortableMove = NonNullable<UseSortableArguments["transition"]>;

/** Full's move, dnd-kit's own (`defaultTransition`, @dnd-kit/sortable 10):
 *  the rows moved this way before the levels. */
export const SORTABLE_MOVE_MS = 200;
/** Full's curve, dnd-kit's own. */
export const SORTABLE_MOVE_EASING = "ease";

/** The rows' move at the level in force: Full dnd-kit's 200 ms `ease`,
 *  Minimal 150 ms on E, Off none; a reorder by the keyboard moves none at
 *  every level (УД4). `null` stands the rows in place at once. */
export function sortableMove(byKey: boolean): SortableMove | null {
  const duration = motionMs(SORTABLE_MOVE_MS, "enter", { byKey });
  if (duration === 0) return null;
  return { duration, easing: motionEasing(SORTABLE_MOVE_MS, "enter", SORTABLE_MOVE_EASING) };
}

/** `sortableMove` for a row inside a `DndContext`, renewed with the level;
 *  a drag the keyboard started counts as a key. */
export function useSortableMove(): SortableMove | null {
  // Subscribed, so a level chosen while the list is open moves its rows.
  useMotionLevel();
  const { activatorEvent } = useDndContext();
  return sortableMove(activatorEvent instanceof KeyboardEvent);
}
