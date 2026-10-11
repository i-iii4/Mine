// Where the overlay stands and how big it is (SPEC_CLIPPER.md, «Доработки после
// живого просмотра», пункт 4 и Р10). The person sets a place and a size by
// dragging the header and any of the four corners; the browser window decides
// what of it can be shown. What was set is kept between openings and never
// changed by the window: the overlay comes back to it once there is room.
// Wherever it stands, the panel keeps 16 px from every edge of the window, as
// in its default place (11.10.2026).

/** The overlay's width before 10.10.2026, the same as the clipper window's. */
export const OVERLAY_MIN_WIDTH = 360;
/** The widest overlay (decision of 10.10.2026). */
export const OVERLAY_MAX_WIDTH = 640;
/** The sum of the panel's rigid parts: below it the panel scrolls as a whole
 *  (SPEC_CLIPPER.md, Layout). */
export const OVERLAY_MIN_HEIGHT = 430;
/** The distance the panel keeps from every edge of the window: its default
 *  place is `right-4 top-4`, and a drag, a resize or a smaller window keep it
 *  too (11.10.2026). */
export const OVERLAY_INSET = 16;
/** Where the place and size are kept, in `chrome.storage.local`. */
export const OVERLAY_BOUNDS_KEY = "mineOverlayBounds";

/** What the person set. A `null` place is the default corner; a `null`
 *  height follows the content. */
export interface OverlayBounds {
  left: number | null;
  top: number | null;
  width: number;
  height: number | null;
}

export const DEFAULT_OVERLAY_BOUNDS: OverlayBounds = { left: null, top: null, width: OVERLAY_MIN_WIDTH, height: null };

export interface Viewport {
  width: number;
  height: number;
}

/** What is drawn now. A `null` height follows the content up to `maxHeight`. */
export interface OverlayFrame {
  left: number;
  top: number;
  width: number;
  height: number | null;
  maxHeight: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/// Where the panel's near edge may stand on one axis of the window: 16 px in
/// from both edges. A window too small for the panel and both insets drops
/// them on that axis and keeps the panel anywhere within the window, as
/// before 11.10.2026: the minimum size outranks the inset.
function edgeRange(size: number, extent: number): [number, number] {
  return extent - size >= 2 * OVERLAY_INSET
    ? [OVERLAY_INSET, extent - OVERLAY_INSET - size]
    : [0, extent - size];
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/// The kept bounds, or the default ones for anything this version did not write.
export function parseOverlayBounds(value: unknown): OverlayBounds {
  if (typeof value !== "object" || value === null) return DEFAULT_OVERLAY_BOUNDS;
  const { left, top, width, height } = value as Record<string, unknown>;
  const place = (finite(left) && finite(top)) ? { left, top } : { left: null, top: null };
  return {
    ...place,
    width: finite(width) ? clamp(width, OVERLAY_MIN_WIDTH, OVERLAY_MAX_WIDTH) : OVERLAY_MIN_WIDTH,
    height: finite(height) ? Math.max(height, OVERLAY_MIN_HEIGHT) : null,
  };
}

/// What of `bounds` the window shows: the size cut to the window less the
/// 16 px insets but not below its minimums, then the place moved so that the
/// whole panel is in the window 16 px in from its edges. The tallest panel is
/// the window's height less 32 px. A window lower than the minimum height
/// and both insets gets a panel of the minimum height anywhere within it,
/// and one lower than the minimum height a panel of its height that scrolls
/// as a whole. `contentHeight` is the panel's height when it follows its
/// content.
export function fitOverlay(bounds: OverlayBounds, viewport: Viewport, contentHeight: number): OverlayFrame {
  const width = clamp(Math.min(bounds.width, viewport.width - 2 * OVERLAY_INSET), OVERLAY_MIN_WIDTH, OVERLAY_MAX_WIDTH);
  const maxHeight = Math.max(viewport.height - 2 * OVERLAY_INSET, 0);
  const height = bounds.height === null
    ? null
    : Math.min(Math.max(Math.min(bounds.height, maxHeight), OVERLAY_MIN_HEIGHT), viewport.height);
  const drawnHeight = height ?? Math.min(contentHeight, maxHeight);
  const left = clamp(bounds.left ?? viewport.width - OVERLAY_INSET - width, ...edgeRange(width, viewport.width));
  const top = clamp(bounds.top ?? OVERLAY_INSET, ...edgeRange(drawnHeight, viewport.height));
  return { left, top, width, height, maxHeight };
}

/// The bounds after the header was dragged by `dx`, `dy` from `frame`: the
/// place moves within the window 16 px in from its edges, the size stays as
/// it was set.
export function dragOverlay(bounds: OverlayBounds, frame: OverlayFrame, drawnHeight: number, dx: number, dy: number, viewport: Viewport): OverlayBounds {
  return {
    ...bounds,
    left: clamp(frame.left + dx, ...edgeRange(frame.width, viewport.width)),
    top: clamp(frame.top + dy, ...edgeRange(drawnHeight, viewport.height)),
  };
}

/** A corner of the panel the person drags to resize it. */
export type OverlayCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export const OVERLAY_CORNERS: readonly OverlayCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

/// The bounds after `corner` was dragged by `dx`, `dy` from `frame`: the
/// opposite corner stays where it was, and the size keeps within its limits
/// and within the window: the dragged corner stops 16 px from its edges.
/// Only the minimum height outranks the fixed corner: a panel that cannot be
/// 430 px tall above or below it grows past it, and `fitOverlay` then keeps
/// the panel in the window.
export function resizeOverlay(frame: OverlayFrame, drawnHeight: number, corner: OverlayCorner, dx: number, dy: number, viewport: Viewport): OverlayBounds {
  const right = frame.left + frame.width;
  const bottom = frame.top + drawnHeight;
  const fromLeft = corner.endsWith("left");
  const fromTop = corner.startsWith("top");
  const width = fromLeft
    ? clamp(frame.width - dx, OVERLAY_MIN_WIDTH, Math.min(OVERLAY_MAX_WIDTH, right - OVERLAY_INSET))
    : clamp(frame.width + dx, OVERLAY_MIN_WIDTH, Math.min(OVERLAY_MAX_WIDTH, viewport.width - OVERLAY_INSET - frame.left));
  const height = fromTop
    ? clamp(drawnHeight - dy, OVERLAY_MIN_HEIGHT, bottom - OVERLAY_INSET)
    : clamp(drawnHeight + dy, OVERLAY_MIN_HEIGHT, viewport.height - OVERLAY_INSET - frame.top);
  return {
    left: fromLeft ? Math.max(right - width, edgeRange(width, viewport.width)[0]) : frame.left,
    top: fromTop ? Math.max(bottom - height, edgeRange(height, viewport.height)[0]) : frame.top,
    width,
    height,
  };
}
