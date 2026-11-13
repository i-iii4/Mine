// Edge treatments. Every edge Mine softens *masks* content with one curve:
// text and previews become transparent as they approach the edge, hiding an
// overflow. The right edge of sidebar rows, both ends of a horizontally
// scrolled row and the top of a rising text card share it.
//
// No edge uses `box-shadow`; that is reserved for floating menus (see
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

/// A mask that fades content out toward its starting edge (the top for
/// `to bottom`, the left for `to right`) with the right edge's curve.
function createLeadingFadeMaskStyle(fadeWidth: number, direction: "to bottom" | "to right"): CSSProperties {
  const stops = [
    "rgba(0, 0, 0, 0) 0px",
    ...[...EDGE_FADE_STOPS]
      .reverse()
      .map(({ alpha, progress }) => `rgba(0, 0, 0, ${alpha}) ${rampOffset(fadeWidth, progress)}px`),
    `rgba(0, 0, 0, 1) ${fadeWidth}px`,
    "rgba(0, 0, 0, 1) 100%",
  ].join(", ");
  const gradient = `linear-gradient(${direction}, ${stops})`;
  return {
    maskImage: gradient,
    WebkitMaskImage: gradient,
  } as CSSProperties;
}

/// Build a mask that fades content out toward the top edge, with the right
/// edge's curve: a rising text card dissolves past the frame's top instead of
/// being cut by it (SPEC_CARD_STATES.md, С8.2).
export function createLiftFadeMaskStyle(fadeWidth: number): CSSProperties {
  return createLeadingFadeMaskStyle(fadeWidth, "to bottom");
}

/// Build a mask that fades content out toward the left edge, with the right
/// edge's curve: tabs scrolled past the start of the tab bar dissolve
/// (SPEC_TABS.md, В48).
export function createLeftFadeMaskStyle(fadeWidth: number): CSSProperties {
  return createLeadingFadeMaskStyle(fadeWidth, "to right");
}

// ─── Horizontal rows: masks both edges ──────────────────────────────────────

/// Scroll offset at which an edge of a horizontally scrolled row counts as
/// hiding content. Sub-pixel offsets are reported during momentum scrolling and
/// resize; one full pixel is the smallest offset that can actually hide content.
const HIDDEN_EDGE_THRESHOLD_PX = 1;

/** Which edges of a horizontally scrolled row hide content: the tab bar's
 *  strip, the bottom bar of a narrow window and a wide article table. */
export function hiddenEdges(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
): { left: boolean; right: boolean } {
  return {
    left: scrollLeft >= HIDDEN_EDGE_THRESHOLD_PX,
    right: scrollWidth - clientWidth - scrollLeft >= HIDDEN_EDGE_THRESHOLD_PX,
  };
}

function maskImage(style: CSSProperties): string {
  return String(style.maskImage);
}

/// The shared edge ramp on both ends of the strip (SPEC_TABS.md, В48).
const RIGHT_EDGE_MASK = maskImage(createRightFadeMaskStyle(EDGE_FADE_WIDTH, 0));
const LEFT_EDGE_MASK = maskImage(createLeftFadeMaskStyle(EDGE_FADE_WIDTH));

/** The mask that dissolves a row's edges where content is hidden past them;
 *  `undefined` when nothing is hidden. Two layers intersect, so both edges
 *  fade at once when the strip is scrolled into its middle. */
export function stripFadeMaskStyle(edges: { left: boolean; right: boolean }): CSSProperties | undefined {
  const layers = [edges.left ? LEFT_EDGE_MASK : null, edges.right ? RIGHT_EDGE_MASK : null].filter(
    (layer): layer is string => layer !== null,
  );
  if (layers.length === 0) return undefined;
  const image = layers.join(", ");
  if (layers.length === 1) return { maskImage: image, WebkitMaskImage: image };
  return {
    maskImage: image,
    WebkitMaskImage: image,
    maskComposite: "intersect",
    WebkitMaskComposite: "source-in",
  };
}

