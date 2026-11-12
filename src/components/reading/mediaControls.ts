import { MINIMAL_ENTER_CLASS, MINIMAL_EXIT_CLASS } from "@/lib/motionClasses";
import { cn } from "@/lib/utils";

/** Minimal shows the controls on the enter time wherever they come up: on the
 *  box's hover or focus as on `visible` (В4). */
const MINIMAL_SHOW_ON_BOX_CLASS =
  "group-hover/detail-media:[[data-motion=minimal]_&]:duration-[var(--motion-enter)] group-focus-within/detail-media:[[data-motion=minimal]_&]:duration-[var(--motion-enter)]";

/** The controls in the top right corner of a picture, a video or a code
 *  block of the open card (⤢, ⋯, Copy): shown while the box, a
 *  `group/detail-media`, is hovered or holds keyboard focus, or while
 *  `visible` (its menu is open). One rule of showing for all of them
 *  (SPEC_READING_MODE.md, Ч6.3). In Minimal they come in on the enter time and
 *  go on the exit time (SPEC_MOTION_LEVELS.md, В4). */
export function mediaControlsClasses(visible: boolean): string {
  return cn(
    "absolute right-2 top-2 z-10 flex gap-1 transition-opacity duration-[160ms]",
    visible ? MINIMAL_ENTER_CLASS : cn(MINIMAL_EXIT_CLASS, MINIMAL_SHOW_ON_BOX_CLASS),
    visible
      ? "opacity-100"
      : "pointer-events-none opacity-0 group-hover/detail-media:pointer-events-auto group-hover/detail-media:opacity-100 group-focus-within/detail-media:pointer-events-auto group-focus-within/detail-media:opacity-100",
  );
}
