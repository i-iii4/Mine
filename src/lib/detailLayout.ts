import type { CSSProperties } from "react";

// The open card's layout and its one media frame (SPEC_FRONTEND.md,
// «Раскладка открытой карточки»; user's decisions of 07.10.2026 and
// 16.10.2026). The component measures; these rules decide.

/** The reading column, `680px` (user's decision of 16.10.2026: 680 instead
 *  of 768, as Medium's; the article's type is unchanged): the content's full
 *  width, unless a lone picture or video is narrower (Р1). The one owner of
 *  the width: the stacking threshold and the stacked panel follow it. */
export const DETAIL_CONTENT_MAX_WIDTH_PX = 680;

/** The panel's column beside the content, `20rem`. */
export const DETAIL_RAIL_WIDTH_PX = 320;

/** A picture or a video in the open card is at most this share of the
 *  window's height, in `vh` (Р7; user's decision of 16.10.2026: the limit
 *  stays). The one owner of the limit: the content's width is computed from
 *  it, and every media frame reads it through `DETAIL_MEDIA_MAX_HEIGHT_VAR`. */
export const DETAIL_MEDIA_MAX_HEIGHT_VH = 85;

/** The CSS variable that carries the height limit to the media frames. */
export const DETAIL_MEDIA_MAX_HEIGHT_VAR = "--detail-media-max-height";

/** How far a video's own proportion may differ from the record's before the
 *  frame takes the video's: an encoder's rounding of an odd side stays
 *  within it, a turned phone video does not (Р6). */
export const DETAIL_MEDIA_PROPORTION_TOLERANCE = 0.01;

/** The open card root's style: the height limit as a CSS length. */
export function detailMediaMaxHeightStyle(): CSSProperties {
  // A custom property is not among the keys React's CSSProperties lists; the
  // value is a plain CSS length, which is what the style object carries.
  return { [DETAIL_MEDIA_MAX_HEIGHT_VAR]: `${DETAIL_MEDIA_MAX_HEIGHT_VH}vh` } as CSSProperties;
}

/** A picture's or a video's own size, in pixels. */
export interface DetailMediaSize {
  width: number;
  height: number;
}

/** The size, when both sides are positive finite numbers; otherwise unknown. */
export function detailMediaSize(
  width: number | null | undefined,
  height: number | null | undefined,
): DetailMediaSize | null {
  if (typeof width !== "number" || typeof height !== "number") return null;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

/** Whether two sizes draw the same proportion, within
 *  `DETAIL_MEDIA_PROPORTION_TOLERANCE`. */
export function sameMediaProportion(a: DetailMediaSize, b: DetailMediaSize): boolean {
  const ratio = (a.width / a.height) / (b.width / b.height);
  return Math.abs(ratio - 1) <= DETAIL_MEDIA_PROPORTION_TOLERANCE;
}

/** How wide the frame draws a medium of `size` in a window `viewportHeight`
 *  tall when the column does not hold it narrower: its own width, or the
 *  width it takes at the height limit (Р6). */
export function detailMediaFrameWidth(size: DetailMediaSize, viewportHeight: number): number {
  const limitHeight = (DETAIL_MEDIA_MAX_HEIGHT_VH * viewportHeight) / 100;
  return Math.min(size.width, (limitHeight * size.width) / size.height);
}

/** The frame's CSS (Р6): the width of `detailMediaFrameWidth`, never wider
 *  than its column, in the medium's own proportion. The medium fills the
 *  frame (`absolute inset-0 size-full`), so the element's box is the drawn
 *  picture: no bars, and a video's own controls no wider than it. */
export function detailMediaFrameStyle(size: DetailMediaSize): CSSProperties {
  return {
    width: `min(${size.width}px, calc(var(${DETAIL_MEDIA_MAX_HEIGHT_VAR}) * ${size.width} / ${size.height}))`,
    maxWidth: "100%",
    aspectRatio: `${size.width} / ${size.height}`,
  };
}

export type DetailLayoutMode = "rail" | "stacked";

export interface DetailLayout {
  mode: DetailLayoutMode;
  /** Beside the panel, the free space on each side of the content: the
   *  same on both sides, so the content stands centred between the open
   *  card's left edge (the sidebar) and the panel. `null` when stacked. */
  sideMarginPx: number | null;
}

/**
 * The open card's layout for the width it has (Р2, Р3): the content beside
 * the panel while the equal margins on either side of it are at least the
 * content inset `contentPadPx`; once they would be narrower, the panel goes
 * under the content at once. `contentWidth` is the drawn content's full
 * width (Р1), so the margins are those of what the reader sees.
 */
export function detailLayout(
  containerWidth: number,
  contentPadPx: number,
  contentWidth: number,
): DetailLayout {
  const sideMarginPx = (containerWidth - contentWidth - DETAIL_RAIL_WIDTH_PX - contentPadPx) / 2;
  return sideMarginPx >= contentPadPx
    ? { mode: "rail", sideMarginPx }
    : { mode: "stacked", sideMarginPx: null };
}

/** The columns beside the panel (Р2): the free space split equally into the
 *  two flexible tracks round the content, the panel an inset off the right
 *  edge. The scroll layer and the fixed panel layer share it. */
export function detailRailGridTemplate(contentWidth: number): string {
  return `minmax(var(--card-content-pad),1fr) ${contentWidth}px minmax(var(--card-content-pad),1fr) ${DETAIL_RAIL_WIDTH_PX}px var(--card-content-pad)`;
}
