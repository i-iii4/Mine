// Edge treatments. Mine softens two kinds of container edge, and they work by
// opposite means.
//
// The right edge of sidebar rows *masks* content: row text and previews become
// transparent as they approach the action column, hiding an overflow.
//
// The top edge of scrollable surfaces does not touch the content at all. The
// chrome colour is extended downward as a band that fades out, so content
// passes underneath at full strength and reads as sliding under the panel.
// Masking was tried there first and was wrong: transparent content dissolves
// into the page background, and on a light background a photograph simply
// bleaches toward white — damaged content rather than depth.
//
// Neither edge uses `box-shadow`; that is reserved for floating menus (see
// DESIGN_SYSTEM.md).

import type { CSSProperties } from "react";

// ─── Right edge: masks content ──────────────────────────────────────────────

/// Width of the right-edge dissolve ramp, in CSS pixels.
export const EDGE_FADE_WIDTH = 24;

/// Perceptual alpha ramp for the right edge, ordered from opaque to transparent.
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

// ─── Top edge: extends the chrome ───────────────────────────────────────────

/// Smootherstep: `6t⁵ − 15t⁴ + 10t³`.
///
/// Both its first and second derivative are zero at `t = 0` and `t = 1`. That
/// matters at each end of the band: a curve arriving at a flat value with a
/// non-zero slope produces a Mach band — the eye amplifies the discontinuity and
/// reports a line that is not in the pixels. At the top that would show as a
/// seam against the chrome, at the bottom as an edge across the content.
const smootherstep = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/// One stop per this many pixels of band.
///
/// The visible artefact is the linear interpolation *between* stops: too few and
/// the band reads as a series of flat facets.
const PIXELS_PER_STOP = 2.5;
const MIN_TOP_FADE_STOPS = 12;
const MAX_TOP_FADE_STOPS = 24;

/// Resolved color scheme.
export type TopFadeAppearance = "light" | "dark";

/// Geometry of the band that continues the chrome over the content.
export interface TopFadeProfile {
  /// Tallest the band ever gets, in CSS pixels. Measured from the reference
  /// screenshots: content reaches full contrast about 41–43px below the edge.
  maxHeight: number;
  /// How much of the content still shows through at the very top of the band.
  ///
  /// Per theme, because the same coverage does not read the same way: a light
  /// band over a dark photograph is far more visible than a dark band over the
  /// same photograph. The light value matches the reference measurement — about
  /// 38–40% of the content's contrast survives at the edge; the dark theme
  /// covers harder, which is what it needs to register at all.
  minAlpha: Record<TopFadeAppearance, number>;
}

/// Profile for large-format content: the feed and Detail.
export const TOP_FADE_CANVAS: TopFadeProfile = {
  maxHeight: 44,
  minAlpha: { light: 0.4, dark: 0.08 },
};

/// Profile for dense lists: the sidebar and search results, whose rows are 32px.
/// A canvas-height band would blanket an entire row.
export const TOP_FADE_LIST: TopFadeProfile = {
  maxHeight: 24,
  minAlpha: { light: 0.4, dark: 0.08 },
};

/// How much of the content shows through at normalized band position `t`, where
/// `0` is the very edge and `1` is the bottom of the band.
///
/// No gamma correction: the band is a colour laid over content, and its own
/// opacity is what the eye judges. The gamma term that a content mask needs
/// would only skew this curve.
export function topFadeAlpha(t: number, minAlpha: number): number {
  return Math.round((minAlpha + (1 - minAlpha) * smootherstep(t)) * 1000) / 1000;
}

/// Number of stops used for a band of the given height.
export function topFadeStopCount(height: number): number {
  return Math.min(
    MAX_TOP_FADE_STOPS,
    Math.max(MIN_TOP_FADE_STOPS, Math.round(height / PIXELS_PER_STOP)),
  );
}

/// Scroll offset at which a surface counts as scrolled and the band appears.
/// Sub-pixel offsets are reported during momentum scrolling and resize; one full
/// pixel is the smallest offset that can actually put content under the chrome.
export const TOP_FADE_SCROLLED_THRESHOLD_PX = 1;

/// Height of the band for a given scroll offset.
///
/// The band grows with the scroll: at 5px scrolled it is 5px tall, because 5px
/// of content is all that has gone under the chrome. A band that appears at full
/// height the instant scrolling starts covers content that has not moved yet —
/// which is what made the sidebar look broken, its 32px band blanketing a 32px
/// row still fully in view.
export function topFadeHeight(
  enabled: boolean,
  scrollTop: number,
  profile: TopFadeProfile,
): number {
  if (!enabled || scrollTop < TOP_FADE_SCROLLED_THRESHOLD_PX) return 0;
  return Math.min(Math.round(scrollTop), profile.maxHeight);
}
