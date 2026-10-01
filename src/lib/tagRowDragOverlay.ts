import { defaultDropAnimationSideEffects } from "@dnd-kit/core";
import type { DropAnimation, Modifier } from "@dnd-kit/core";
import { prefersReducedMotion } from "@/lib/motion";

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
const TAG_ROW_DROP_ANIMATION: DropAnimation = {
  duration: 200,
  easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: "0" } },
  }),
};

/// The drop flight under the current motion setting. dnd-kit plays it with
/// Web Animations, which the global reduced-motion CSS rule does not reach,
/// so Reduce motion is asked here: no flight, the row lands where it is
/// dropped (SPEC_AUDIT_FIXES.md, Ф12, Г5.2). Read at render, so the setting at
/// the moment of the drag decides.
export function tagRowDropAnimation(): DropAnimation | null {
  return prefersReducedMotion() ? null : TAG_ROW_DROP_ANIMATION;
}

export const TAG_ROW_OVERLAY_MODIFIERS: Modifier[] = [];
