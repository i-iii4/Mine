// Where the overlay stands and how big it is (SPEC_CLIPPER.md, «Доработки после
// живого просмотра», пункт 4 и Р10). The person sets a place and a size by
// dragging the header and the bottom right corner; the browser window decides
// what of it can be shown. What was set is kept between openings and never
// changed by the window: the overlay comes back to it once there is room.

/** The overlay's width before 10.10.2026, the same as the clipper window's. */
export const OVERLAY_MIN_WIDTH = 360;
/** The widest overlay (decision of 10.10.2026). */
export const OVERLAY_MAX_WIDTH = 640;
/** The sum of the panel's rigid parts: below it the panel scrolls as a whole
 *  (SPEC_CLIPPER.md, Layout). */
export const OVERLAY_MIN_HEIGHT = 430;
/** The default distance from the window's top and right edges, `right-4 top-4`. */
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

/// What of `bounds` the window shows: the size cut to the window but not
/// below its minimums, then the place moved so that the whole panel is in the
/// window. A window lower than the minimum height gets a panel of its height
/// that scrolls as a whole. `contentHeight` is the panel's height when it
/// follows its content.
export function fitOverlay(bounds: OverlayBounds, viewport: Viewport, contentHeight: number): OverlayFrame {
  const width = clamp(Math.min(bounds.width, viewport.width), OVERLAY_MIN_WIDTH, OVERLAY_MAX_WIDTH);
  const height = bounds.height === null
    ? null
    : Math.min(Math.max(bounds.height, OVERLAY_MIN_HEIGHT), viewport.height);
  const maxHeight = Math.max(viewport.height - 2 * OVERLAY_INSET, 0);
  const drawnHeight = height ?? Math.min(contentHeight, maxHeight);
  const left = clamp(bounds.left ?? viewport.width - OVERLAY_INSET - width, 0, viewport.width - width);
  const top = clamp(bounds.top ?? OVERLAY_INSET, 0, viewport.height - drawnHeight);
  return { left, top, width, height, maxHeight };
}

/// The bounds after the header was dragged by `dx`, `dy` from `frame`: the
/// place moves within the window, the size stays as it was set.
export function dragOverlay(bounds: OverlayBounds, frame: OverlayFrame, drawnHeight: number, dx: number, dy: number, viewport: Viewport): OverlayBounds {
  return {
    ...bounds,
    left: clamp(frame.left + dx, 0, viewport.width - frame.width),
    top: clamp(frame.top + dy, 0, viewport.height - drawnHeight),
  };
}

/// The bounds after the bottom right corner was dragged by `dx`, `dy` from
/// `frame`: the top left corner stays, the size keeps within its limits and
/// within the window.
export function resizeOverlay(frame: OverlayFrame, drawnHeight: number, dx: number, dy: number, viewport: Viewport): OverlayBounds {
  return {
    left: frame.left,
    top: frame.top,
    width: clamp(frame.width + dx, OVERLAY_MIN_WIDTH, Math.min(OVERLAY_MAX_WIDTH, viewport.width - frame.left)),
    height: clamp(drawnHeight + dy, OVERLAY_MIN_HEIGHT, viewport.height - frame.top),
  };
}
