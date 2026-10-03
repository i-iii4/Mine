// The arithmetic of dragging tabs (SPEC_TABS.md, В60 по В63). Pure: the bar
// feeds pointer positions and tab geometry, these decide what moves where.

import {
  CHROME_DRAG_THRESHOLD_PX,
  TAB_BAR_HEIGHT_PX,
  TAB_DETACH_THRESHOLD_PX,
} from "./constants";

/** Whether the pointer has travelled far enough from the press to drag:
 *  the chrome's threshold gesture, measured the same way. */
export function pastDragThreshold(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= CHROME_DRAG_THRESHOLD_PX;
}

/** Where the dragged tab stands, as an offset from its own slot: it follows
 *  the pointer but never leaves the row of tabs. */
export function draggedOffset({
  fromIndex,
  dx,
  width,
  count,
}: {
  fromIndex: number;
  dx: number;
  width: number;
  count: number;
}): number {
  const origin = fromIndex * width;
  const left = Math.min(Math.max(0, origin + dx), Math.max(0, count - 1) * width);
  return left - origin;
}

/** The slot the dragged tab takes if dropped now: the one its left edge is
 *  nearest to, so a tab changes places once it covers half of a neighbour. */
export function reorderTarget({
  fromIndex,
  offset,
  width,
  count,
}: {
  fromIndex: number;
  offset: number;
  width: number;
  count: number;
}): number {
  if (count <= 1 || width <= 0) return 0;
  const slot = Math.round((fromIndex * width + offset) / width);
  return Math.min(Math.max(0, slot), count - 1);
}

/** How far tab `index` moves aside while the tab at `fromIndex` hovers over
 *  slot `toIndex`: the tabs between the two close the gap by one width. */
export function neighbourShift({
  index,
  fromIndex,
  toIndex,
  width,
}: {
  index: number;
  fromIndex: number;
  toIndex: number;
  width: number;
}): number {
  if (index === fromIndex) return 0;
  if (fromIndex < toIndex && index > fromIndex && index <= toIndex) return -width;
  if (toIndex < fromIndex && index >= toIndex && index < fromIndex) return width;
  return 0;
}

/** `items` with the one at `from` moved to `to`; an equal copy when nothing moves. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (from === to || from < 0 || from >= next.length) return next;
  const moved = next.splice(from, 1);
  next.splice(Math.min(Math.max(0, to), next.length), 0, ...moved);
  return next;
}

/** Whether the pointer has pulled the tab off the bar: further below it than
 *  `TAB_DETACH_THRESHOLD_PX`, or out of the window across or upward (В61).
 *  Coordinates are the bar page's, whose origin is the window's corner. */
export function pulledOffBar({
  clientX,
  clientY,
  windowWidth,
}: {
  clientX: number;
  clientY: number;
  windowWidth: number;
}): boolean {
  return (
    clientY > TAB_BAR_HEIGHT_PX + TAB_DETACH_THRESHOLD_PX
    || clientY < 0
    || clientX < 0
    || clientX > windowWidth
  );
}

/** Where the backend keeps the pointer in the window that carries the torn
 *  tab: over that tab with the offset it was grabbed at. A window of its own
 *  shows the tab first in the strip, so the point is the strip's start plus
 *  the grab offset within the tab. For the only tab of a window this is the
 *  press point itself, and the window moves under the pointer unchanged
 *  (В61, В62). */
export function grabPoint({
  pressX,
  pressY,
  stripLeft,
  scrollLeft,
  fromIndex,
  width,
}: {
  pressX: number;
  pressY: number;
  stripLeft: number;
  scrollLeft: number;
  fromIndex: number;
  width: number;
}): { x: number; y: number } {
  const tabLeft = stripLeft + fromIndex * width - scrollLeft;
  return { x: stripLeft + (pressX - tabLeft), y: pressY };
}

/** Where the tabs' horizontal centres stand now, in the bar's coordinates,
 *  left to right. */
export function tabCentres({
  stripLeft,
  scrollLeft,
  width,
  count,
}: {
  stripLeft: number;
  scrollLeft: number;
  width: number;
  count: number;
}): number[] {
  return Array.from({ length: count }, (_, index) => stripLeft - scrollLeft + index * width + width / 2);
}

/** The slot a tab dragged in from another window would take with the pointer
 *  at bar position `x` (В63): as many tabs come before it as have their
 *  centre left of the pointer. */
export function dropSlot(x: number, centres: readonly number[]): number {
  return centres.filter((centre) => centre < x).length;
}

/** Where the insertion marker stands in the strip's content: centred on the
 *  boundary before slot `slot`, and inside the row at both of its ends. */
export function dropMarkerLeft({
  slot,
  width,
  count,
  markerWidth,
}: {
  slot: number;
  width: number;
  count: number;
  markerWidth: number;
}): number {
  const boundary = slot * width - markerWidth / 2;
  return Math.min(Math.max(0, boundary), Math.max(0, count * width - markerWidth));
}
