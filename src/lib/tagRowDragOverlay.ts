import { defaultDropAnimationSideEffects } from "@dnd-kit/core";
import type { DropAnimation, Modifier } from "@dnd-kit/core";
import type { UseSortableArguments } from "@dnd-kit/sortable";
import { motionEasing, motionMs } from "@/lib/motion";

/// DragOverlay dressing for reordering a collection row.
///
/// The overlay is the row itself, so it keeps the grab point (no cursor-snap
/// modifier) and, on release, flies into the hole the list is holding open for
/// it. The side effect keeps the real row hidden until the flight ends —
/// without it the row pops in at the destination while the copy is still
/// travelling, and the drop reads as a double image.
///
/// Shared by the app and the sidebar-reorder audit route so the gesture the
/// audit measures is the gesture the app ships.

/** The drop flight in Full: 200 ms on E. */
export const TAG_ROW_DROP_MS = 200;
export const TAG_ROW_DROP_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

/** dnd-kit's transition of a sortable row; the package does not export its name. */
type SortableTransition = NonNullable<UseSortableArguments["transition"]>;

/** The neighbours parting for the dragged row in Full: dnd-kit's own, 250 ms
 *  `ease`. */
export const TAG_ROW_SORT_MS = 250;
export const TAG_ROW_SORT_EASING = "ease";

const TAG_ROW_DROP_SIDE_EFFECTS = defaultDropAnimationSideEffects({
  styles: { active: { opacity: "0" } },
});

/// The drop flight at the level in force (SPEC_MOTION_LEVELS.md, С9): Full
/// 200 ms, Minimal 150 ms, both on E; Off none, the row lands where it is
/// dropped. dnd-kit plays it with Web Animations, which no CSS rule of the
/// level reaches, so the level is asked here (Р2). Read at render, so the
/// level at the moment of the drag decides.
export function tagRowDropAnimation(): DropAnimation | null {
  const duration = motionMs(TAG_ROW_DROP_MS, "enter");
  if (duration === 0) return null;
  return {
    duration,
    easing: motionEasing(TAG_ROW_DROP_MS, "enter", TAG_ROW_DROP_EASING),
    sideEffects: TAG_ROW_DROP_SIDE_EFFECTS,
  };
}

/// The neighbours' move to their new places at the level in force (С9): Full
/// 250 ms `ease`, Minimal 150 ms on E, Off none, they stand there at once.
export function tagRowSortTransition(): SortableTransition | null {
  const duration = motionMs(TAG_ROW_SORT_MS, "enter");
  if (duration === 0) return null;
  return { duration, easing: motionEasing(TAG_ROW_SORT_MS, "enter", TAG_ROW_SORT_EASING) };
}

export const TAG_ROW_OVERLAY_MODIFIERS: Modifier[] = [];
