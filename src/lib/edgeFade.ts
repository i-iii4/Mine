// Shared edge fade contract. One perceptual curve owns every place where Mine
// dissolves content into transparency at a container edge: sidebar row text and
// previews fade toward the right guideline, scrollable surfaces fade toward the
// top edge under the chrome.
//
// The curve is a mask, not a shadow. Masked content becomes transparent, so the
// surface behind it stays visible and the effect is theme-independent. Mine
// separates planes with background levels, borders and masks; `box-shadow` is
// reserved for floating menus (see DESIGN_SYSTEM.md).

import type { CSSProperties } from "react";

/// Width of the dissolve ramp, in CSS pixels. Shared by every edge.
export const EDGE_FADE_WIDTH = 24;

/// Perceptual alpha ramp, ordered from opaque to transparent.
///
/// `progress` is the normalized distance travelled along the ramp: `0` is the
/// opaque start, `1` is the fully transparent edge. The stops are deliberately
/// not linear — a linear alpha ramp reads as a hard band because perceived
/// opacity falls off faster than the alpha value does.
const EDGE_FADE_STOPS: readonly { alpha: number; progress: number }[] = [
  { alpha: 0.82, progress: 0.14 },
  { alpha: 0.64, progress: 0.24 },
  { alpha: 0.49, progress: 0.33 },
  { alpha: 0.36, progress: 0.45 },
  { alpha: 0.25, progress: 0.57 },
  { alpha: 0.16, progress: 0.69 },
  { alpha: 0.09, progress: 0.81 },
  { alpha: 0.04, progress: 0.9 },
  { alpha: 0.01, progress: 0.97 },
];

/// Round a ramp offset to two decimals so generated gradients stay stable
/// strings across renders instead of drifting with floating point noise.
const rampOffset = (fadeWidth: number, progress: number) =>
  Math.round(fadeWidth * (1 - progress) * 100) / 100;

/// Build a mask that fades content out toward the right edge.
///
/// `clearTailWidth` reserves fully transparent space at the right edge, used by
/// sidebar rows to clear the action-button column before the ramp begins.
export function createRightFadeMaskStyle(
  fadeWidth: number,
  clearTailWidth: number,
): CSSProperties {
  const stops = [
    "rgba(0, 0, 0, 1) 0%",
    `rgba(0, 0, 0, 1) calc(100% - ${clearTailWidth + fadeWidth}px)`,
    ...EDGE_FADE_STOPS.map(
      ({ alpha, progress }) =>
        `rgba(0, 0, 0, ${alpha}) calc(100% - ${clearTailWidth + rampOffset(fadeWidth, progress)}px)`,
    ),
    `rgba(0, 0, 0, 0) calc(100% - ${clearTailWidth}px)`,
    "rgba(0, 0, 0, 0) 100%",
  ].join(", ");
  const gradient = `linear-gradient(to right, ${stops})`;
  return {
    maskImage: gradient,
    WebkitMaskImage: gradient,
  } as CSSProperties;
}

/// Build a mask that fades content out toward the top edge.
///
/// Same ramp as the right edge, mirrored: the transparent end sits at the top of
/// the box and the content becomes fully opaque `fadeWidth` pixels below it.
/// Applied to a scroll container, this dissolves rows as they travel up under
/// the chrome instead of clipping them at a hard line.
export function createTopFadeMaskStyle(fadeWidth: number): CSSProperties {
  const stops = [
    "rgba(0, 0, 0, 0) 0px",
    ...[...EDGE_FADE_STOPS]
      .reverse()
      .map(
        ({ alpha, progress }) =>
          `rgba(0, 0, 0, ${alpha}) ${rampOffset(fadeWidth, progress)}px`,
      ),
    `rgba(0, 0, 0, 1) ${fadeWidth}px`,
    "rgba(0, 0, 0, 1) 100%",
  ].join(", ");
  const gradient = `linear-gradient(to bottom, ${stops})`;
  return {
    maskImage: gradient,
    WebkitMaskImage: gradient,
  } as CSSProperties;
}

/// The single top-edge mask used by every scrollable surface.
export const TOP_FADE_MASK_STYLE = createTopFadeMaskStyle(EDGE_FADE_WIDTH);

/// Scroll offset at which a surface counts as scrolled and the top fade turns
/// on. Sub-pixel offsets are reported during momentum scrolling and resize; one
/// full pixel is the smallest offset that can actually hide content.
///
/// Surfaces that already track their scroll offset (the feed) compare against
/// this directly instead of attaching a second scroll listener; the rest go
/// through `useTopFadeMask`.
export const TOP_FADE_SCROLLED_THRESHOLD_PX = 1;

/// Resolve the top fade style for a surface that already knows its scroll
/// offset. Returns `undefined` when the fade is off or the surface is at rest,
/// leaving the element's `style` free of mask properties.
export function topFadeMaskStyleFor(
  enabled: boolean,
  scrollTop: number,
): CSSProperties | undefined {
  return enabled && scrollTop >= TOP_FADE_SCROLLED_THRESHOLD_PX
    ? TOP_FADE_MASK_STYLE
    : undefined;
}
