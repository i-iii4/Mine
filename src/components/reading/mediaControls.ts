import { cn } from "@/lib/utils";

/** The controls in the top right corner of a picture, a video or a code
 *  block of the open card (⤢, ⋯, Copy): shown while the box, a
 *  `group/detail-media`, is hovered or holds keyboard focus, or while
 *  `visible` (its menu is open). One rule of showing for all of them
 *  (SPEC_READING_MODE.md, Ч6.3). */
export function mediaControlsClasses(visible: boolean): string {
  return cn(
    "absolute right-2 top-2 z-10 flex gap-1 transition-opacity duration-[160ms]",
    visible
      ? "opacity-100"
      : "pointer-events-none opacity-0 group-hover/detail-media:pointer-events-auto group-hover/detail-media:opacity-100 group-focus-within/detail-media:pointer-events-auto group-focus-within/detail-media:opacity-100",
  );
}
