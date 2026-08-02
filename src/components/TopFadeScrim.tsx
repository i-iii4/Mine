// The chrome, continued downward as a fading band.
//
// Earlier revisions masked the scroll container itself, making content
// transparent as it approached the edge. That is a different effect: masked
// content dissolves into nothing and, on a light background, a photograph
// simply bleaches toward white. It reads as damaged content, not as depth.
//
// Here the chrome colour itself extends past its own edge and fades out. The
// content keeps its own opacity and passes underneath, so the band reads as the
// panel continuing over it — which is exactly what "content slides under the
// chrome" looks like.
//
// The band is a sibling of the scroll container, not part of it: it never
// scrolls, never enters the scrolled subtree, and costs no compositing on the
// scrolling layer.

import type { CSSProperties } from "react";
import { topFadeAlpha, topFadeStopCount, type TopFadeProfile } from "@/lib/edgeFade";
import { useThemeAppearance } from "@/hooks/useThemeAppearance";

/// Build the band's background: the surface colour at full strength against the
/// edge, fading to fully transparent over `height`.
///
/// Stops are generated from the shared curve. Colour is mixed against
/// `transparent` rather than interpolated by the browser, because interpolating
/// a colour to `transparent` passes through transparent black and greys the
/// midpoint of the gradient.
export function createTopFadeScrimStyle(
  height: number,
  minAlpha: number,
  color: string,
): CSSProperties {
  const stopCount = topFadeStopCount(height);
  const stops: string[] = [];

  for (let i = 0; i <= stopCount; i += 1) {
    const t = i / stopCount;
    // The curve describes content opacity; the band is its complement.
    const strength = 1 - topFadeAlpha(t, minAlpha);
    const percent = Math.round(strength * 1000) / 10;
    const position = Math.round(t * height * 100) / 100;
    stops.push(
      `color-mix(in oklab, ${color} ${percent}%, transparent) ${position}px`,
    );
  }

  return {
    backgroundImage: `linear-gradient(to bottom, ${stops.join(", ")})`,
  };
}

interface TopFadeScrimProps {
  /// Coverage profile for this surface.
  profile: TopFadeProfile;
  /// Current band height in CSS pixels. Zero means no band at all: at rest
  /// there is nothing underneath for the chrome to continue over.
  height: number;
  /// Marks the band in the DOM for acceptance checks.
  surface: string;
  /// Background colour of the surface the band sits on, as a CSS value.
  ///
  /// It must be the colour *behind the content*, not the chrome above it. Mine's
  /// chrome and page background are different tokens (`0.17` against `0.14` in
  /// the dark theme), so a band painted in the chrome colour reads as a
  /// rectangle of the wrong shade sitting on the feed.
  color: string;
}

export function TopFadeScrim({ profile, height, surface, color }: TopFadeScrimProps) {
  const appearance = useThemeAppearance();
  if (height <= 0) return null;

  // Rendered as the first child of the scroll container. The outer element is
  // sticky with zero height, so it holds the band against the top edge while
  // taking no space in the scrolled flow — no wrapper element and no change to
  // the surrounding layout.
  return (
    <div
      aria-hidden="true"
      data-top-fade-scrim={surface}
      className="pointer-events-none sticky top-0 z-10 h-0"
    >
      <div
        className="w-full"
        style={{
          height,
          ...createTopFadeScrimStyle(height, profile.minAlpha[appearance], color),
        }}
      />
    </div>
  );
}
