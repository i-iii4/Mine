// The chrome, continued over the content as a fading band.
//
// Three constraints shaped this, each learned by getting it wrong:
//
// 1. The band lives *outside* the scroll container, absolutely positioned in its
//    parent. Inside it, `position: sticky` cannot escape the container's padding
//    box — it settled below the real edge and narrower than the surface — and it
//    put layout work on the scrolling subtree.
// 2. Its height is constant. Driving height from the scroll offset re-rendered
//    the whole surface on every scrolled pixel and made scrolling stutter.
// 3. Only opacity changes, and only when the surface crosses between "at rest"
//    and "scrolled". Opacity is compositor-only, so the transition costs no
//    layout and no paint of the content beneath.
//
// The band paints the colour *behind* the content, not the chrome above it: in
// Mine those are different tokens, and the chrome colour left a rectangle of the
// wrong shade sitting on the feed.

import type { CSSProperties } from "react";
import { topFadeAlpha, topFadeStopCount, type TopFadeProfile } from "@/lib/edgeFade";
import { useThemeAppearance } from "@/hooks/useThemeAppearance";

/// Build the band's background: the surface colour at full strength against the
/// edge, fading to fully transparent over `height`.
///
/// Stops are generated from the shared curve. Colour is mixed against
/// `transparent` explicitly rather than left to the browser, because
/// interpolating a colour to `transparent` passes through transparent black and
/// greys the midpoint of the gradient.
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
    stops.push(`color-mix(in oklab, ${color} ${percent}%, transparent) ${position}px`);
  }

  return { backgroundImage: `linear-gradient(to bottom, ${stops.join(", ")})` };
}

interface TopFadeScrimProps {
  /// Coverage profile for this surface.
  profile: TopFadeProfile;
  /// Whether the surface below is scrolled.
  scrolled: boolean;
  /// Marks the band in the DOM for acceptance checks.
  surface: string;
  /// Background colour of the surface the band sits on, as a CSS value.
  color: string;
}

export function TopFadeScrim({ profile, scrolled, surface, color }: TopFadeScrimProps) {
  const appearance = useThemeAppearance();

  return (
    <div
      aria-hidden="true"
      data-top-fade-scrim={surface}
      data-top-fade-visible={scrolled ? "true" : "false"}
      className="pointer-events-none absolute inset-x-0 top-0 z-10 transition-opacity duration-150"
      style={{
        height: profile.maxHeight,
        opacity: scrolled ? 1 : 0,
        ...createTopFadeScrimStyle(profile.maxHeight, profile.minAlpha[appearance], color),
      }}
    />
  );
}
