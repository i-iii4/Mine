// What the two-finger swipe asks the page (SPEC_NARROW_WINDOW.md, У17). The
// swipe is recognised natively (src-tauri/src/swipe_gesture.rs), where nothing is
// known of the page's elements: when the fingers land, the native side evaluates
// the global below at the pointer. A gesture that begins over an element that
// scrolls sideways belongs to that element, and the sidebar does not move.

import { hiddenEdges } from "@/lib/edgeFade";

declare global {
  interface Window {
    /** The name is repeated in `SCROLLER_QUESTION` in swipe_gesture.rs;
     *  horizontalScroller.test.ts compares the two. */
    __MINE_HORIZONTAL_SCROLLER_AT__?: (x: number, y: number) => boolean;
  }
}

/** Whether the person can scroll `element` sideways: its content is wider than
 *  it, on either side of where it stands now, and `overflow-x` lets them. */
export function scrollsHorizontally(element: Element): boolean {
  const edges = hiddenEdges(element.scrollLeft, element.clientWidth, element.scrollWidth);
  if (!edges.left && !edges.right) return false;
  const { overflowX } = getComputedStyle(element);
  return overflowX === "auto" || overflowX === "scroll";
}

/** Whether the element at this point of the viewport, in CSS pixels, scrolls
 *  sideways or stands inside an element that does: WebKit hands the movement up
 *  to it. */
export function overHorizontalScroller(x: number, y: number): boolean {
  for (let element = document.elementFromPoint(x, y); element; element = element.parentElement) {
    if (scrollsHorizontally(element)) return true;
  }
  return false;
}

/** Let the native side ask this page. Once per page, before its first frame. */
export function answerSwipeQuestion(): void {
  window.__MINE_HORIZONTAL_SCROLLER_AT__ = overHorizontalScroller;
}
