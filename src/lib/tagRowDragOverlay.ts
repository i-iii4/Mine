import { defaultDropAnimationSideEffects } from "@dnd-kit/core";
import type { DropAnimation, Modifier } from "@dnd-kit/core";
import type { UseSortableArguments } from "@dnd-kit/sortable";
import { roleEasing, roleMs } from "@/lib/motion";

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

/** dnd-kit's transition of a sortable row; the package does not export its name. */
type SortableTransition = NonNullable<UseSortableArguments["transition"]>;

const TAG_ROW_DROP_SIDE_EFFECTS = defaultDropAnimationSideEffects({
  styles: { active: { opacity: "0" } },
});

/// The drop flight, Перемещение (SPEC_MOTION_LEVELS.md, С9, РД1): it answers
/// a drag in hand, so it is the same in every mode («Режимы»). dnd-kit plays
/// it with Web Animations, so the time is asked here.
export function tagRowDropAnimation(): DropAnimation | null {
  const duration = roleMs("move", "enter", { answers: true });
  if (duration === 0) return null;
  return {
    duration,
    easing: roleEasing("move"),
    sideEffects: TAG_ROW_DROP_SIDE_EFFECTS,
  };
}

/// The neighbours' move to their new places, the same Перемещение (С9), the
/// same in every mode: they answer the drag.
export function tagRowSortTransition(): SortableTransition | null {
  const duration = roleMs("move", "enter", { answers: true });
  if (duration === 0) return null;
  return { duration, easing: roleEasing("move") };
}

export const TAG_ROW_OVERLAY_MODIFIERS: Modifier[] = [];
