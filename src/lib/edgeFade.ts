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
/// sidebar rows to clear the action-button column before the ramp begins. It
/// takes a CSS length as well as a number, because that column's width depends
/// on a variable the design variant sets — a mask baked from pixels alone
/// would keep clearing the wrong strip there.
export function createRightFadeMaskStyle(
  fadeWidth: number,
  clearTailWidth: number | string,
): CSSProperties {
  const tail = (extra: number): string =>
    typeof clearTailWidth === "number"
      ? `${clearTailWidth + extra}px`
      : extra === 0
        ? clearTailWidth
        : `calc(${clearTailWidth} + ${extra}px)`;
  const stops = [
    "rgba(0, 0, 0, 1) 0%",
    `rgba(0, 0, 0, 1) calc(100% - ${tail(fadeWidth)})`,
    ...EDGE_FADE_STOPS.map(
      ({ alpha, progress }) =>
        `rgba(0, 0, 0, ${alpha}) calc(100% - ${tail(rampOffset(fadeWidth, progress))})`,
    ),
    `rgba(0, 0, 0, 0) calc(100% - ${tail(0)})`,
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

/// Band height in CSS pixels, shared by every surface.
///
/// One value, not a per-surface profile: the band means the same thing
/// everywhere — content has gone under the chrome — so it should read the same
/// everywhere. It also has to stay inside the sidebar's 32px rows, and the
/// height that satisfies the tightest surface satisfies the rest.
export const TOP_FADE_HEIGHT = 24;

/// The band is a dark-theme treatment only.
///
/// A band works by covering content with the surface colour. In the dark theme
/// that colour is near-black and the covered pixels darken — the content reads
/// as receding. In the light theme the same operation lightens the content
/// toward white, and a photograph does not read as receding when it bleaches;
/// it reads as damaged. Every tuning pass on the light theme traded one defect
/// for another, so the effect is simply off there.
export function isTopFadeSupported(appearance: TopFadeAppearance): boolean {
  return appearance === "dark";
}

/// How much of the content still shows through at the very top of the band.
export const TOP_FADE_MIN_ALPHA = 0.08;

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

