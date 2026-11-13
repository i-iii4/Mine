import { RESPONSE_ENTER_CLASS, RESPONSE_EXIT_CLASS } from "@/lib/motionClasses";
import { cn } from "@/lib/utils";

/** The controls come in on Отклик's enter time wherever they come up: on the
 *  box's hover or focus as on `visible` (В4). */
const SHOW_ON_BOX_CLASS =
  "group-hover/detail-media:duration-(--motion-enter) group-focus-within/detail-media:duration-(--motion-enter)";

/** The controls in the top right corner of a picture, a video or a code
 *  block of the open card (⤢, ⋯, Copy): shown while the box, a
 *  `group/detail-media`, is hovered or holds keyboard focus, or while
 *  `visible` (its menu is open). One rule of showing for all of them
 *  (SPEC_READING_MODE.md, Ч6.3). They come in on the enter time and go on the
 *  exit time, as every button that comes up under the pointer
 *  (SPEC_MOTION_LEVELS.md, В4; user's decision of 12.11.2026). */
export function mediaControlsClasses(visible: boolean): string {
  return cn(
    "absolute right-2 top-2 z-10 flex gap-1 transition-opacity",
    visible ? RESPONSE_ENTER_CLASS : cn(RESPONSE_EXIT_CLASS, SHOW_ON_BOX_CLASS),
    visible
      ? "opacity-100"
      : "pointer-events-none opacity-0 group-hover/detail-media:pointer-events-auto group-hover/detail-media:opacity-100 group-focus-within/detail-media:pointer-events-auto group-focus-within/detail-media:opacity-100",
  );
}
