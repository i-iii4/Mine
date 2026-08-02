// Edge fade contract. Mine dissolves content into transparency at two kinds of
// edge: sidebar row text and previews fade toward the right guideline, and
// scrollable surfaces fade toward the top edge under the chrome.
//
// The effect is a mask, not a shadow. Masked content becomes transparent, so the
// surface behind it stays visible and the result is theme-independent. Mine
// separates planes with background levels, borders and masks; `box-shadow` is
// reserved for floating menus (see DESIGN_SYSTEM.md).
//
// The two edges solve different problems and therefore use different curves.
// The right edge hides a text overflow: it is a hand-tuned table that ends in
// full transparency. The top edge suggests content continuing past a boundary:
// it is generated from a closed-form curve, keeps a faint remainder, and scales
// its ramp to the content it covers.

import type { CSSProperties } from "react";

// ─── Right edge ─────────────────────────────────────────────────────────────

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

// ─── Top edge ───────────────────────────────────────────────────────────────

/// Smootherstep: `6t⁵ − 15t⁴ + 10t³`.
///
/// Both its first and second derivative are zero at `t = 0` and `t = 1`. That
/// matters at each end of the ramp: a curve arriving at a flat value with a
/// non-zero slope produces a Mach band — the eye amplifies the discontinuity and
/// reports a bright line that is not in the pixels.
const smootherstep = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/// Gamma applied on top of the smootherstep shape.
///
/// The browser composites alpha linearly over sRGB values, but perceived
/// brightness is roughly a power law. Without this correction a geometrically
/// even ramp looks like it collapses early and then crawls; `1.8` is the
/// exponent that made the hand-tuned right-edge table look even, so the two
/// edges keep a common visual character.
const TOP_FADE_GAMMA = 1.8;

/// One stop per this many pixels of ramp.
///
/// 8-bit alpha gives ~256 levels, but the visible artefact is the linear
/// interpolation *between* stops: too few stops and the ramp reads as a series
/// of flat facets. Roughly one stop every 2.5px keeps each segment below the
/// threshold where its linear approximation becomes visible.
const PIXELS_PER_STOP = 2.5;
const MIN_TOP_FADE_STOPS = 12;
const MAX_TOP_FADE_STOPS = 24;

/// A top-fade profile: how far the ramp runs and how much opacity survives at
/// the very edge.
export interface TopFadeProfile {
  /// Ramp length in CSS pixels.
  width: number;
  /// Opacity at the very top edge. Never zero — content that dissolves
  /// completely reads as clipped, while a faint remainder reads as content
  /// continuing past the chrome.
  minAlpha: number;
}

/// Profile for large-format content: the feed and Detail, where a single card or
/// image spans hundreds of pixels.
///
/// Below roughly 24px a ramp stops reading as a gradient and becomes a halo
/// around the edge — the alpha step per pixel rises above the threshold where
/// the eye resolves the transition itself. At 56px the step is small enough that
/// the curve, not the length, decides how the fade looks.
export const TOP_FADE_CANVAS: TopFadeProfile = { width: 56, minAlpha: 0.06 };

/// Profile for dense lists: the sidebar and search results, whose rows are 32px.
/// A canvas-width ramp would swallow a whole row, so the ramp is shorter and
/// leans on a slightly stronger remainder to stay distinguishable from a cut.
export const TOP_FADE_LIST: TopFadeProfile = { width: 28, minAlpha: 0.08 };

/// Alpha at normalized ramp position `t`, where `0` is the very edge and `1` is
/// the end of the ramp.
export function topFadeAlpha(t: number, minAlpha: number): number {
  const shaped = smootherstep(t) ** TOP_FADE_GAMMA;
  return Math.round((minAlpha + (1 - minAlpha) * shaped) * 1000) / 1000;
}

/// Number of stops used for a ramp of the given width.
export function topFadeStopCount(width: number): number {
  return Math.min(
    MAX_TOP_FADE_STOPS,
    Math.max(MIN_TOP_FADE_STOPS, Math.round(width / PIXELS_PER_STOP)),
  );
}

/// Build a mask that fades content out toward the top edge.
///
/// Transparent-but-not-invisible at the top of the box, fully opaque `width`
/// pixels below it. Applied to a scroll container, this dissolves content as it
/// travels up under the chrome instead of clipping it at a hard line.
export function createTopFadeMaskStyle({ width, minAlpha }: TopFadeProfile): CSSProperties {
  const stopCount = topFadeStopCount(width);
  const stops: string[] = [];

  for (let i = 0; i <= stopCount; i += 1) {
    const t = i / stopCount;
    const position = Math.round(t * width * 100) / 100;
    stops.push(`rgba(0, 0, 0, ${topFadeAlpha(t, minAlpha)}) ${position}px`);
  }
  stops.push("rgba(0, 0, 0, 1) 100%");

  const gradient = `linear-gradient(to bottom, ${stops.join(", ")})`;
  return {
    maskImage: gradient,
    WebkitMaskImage: gradient,
  } as CSSProperties;
}

const TOP_FADE_STYLES: Record<TopFadeVariant, CSSProperties> = {
  canvas: createTopFadeMaskStyle(TOP_FADE_CANVAS),
  list: createTopFadeMaskStyle(TOP_FADE_LIST),
};

/// Which profile a surface uses. `canvas` for the feed and Detail, `list` for
/// the sidebar and search results.
export type TopFadeVariant = "canvas" | "list";

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
  variant: TopFadeVariant,
): CSSProperties | undefined {
  return enabled && scrollTop >= TOP_FADE_SCROLLED_THRESHOLD_PX
    ? TOP_FADE_STYLES[variant]
    : undefined;
}
