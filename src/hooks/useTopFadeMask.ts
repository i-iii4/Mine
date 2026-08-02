// Top-edge fade activation for a scroll container.
//
// The mask is only meaningful once content has actually travelled up under the
// chrome: at rest the first row must stay fully opaque. The hook therefore
// tracks a single boolean — "is this surface scrolled" — instead of a scroll
// offset, so ordinary scrolling produces no re-render once the mask is on.

import { useEffect, useState, type CSSProperties, type RefObject } from "react";
import { TOP_FADE_SCROLLED_THRESHOLD_PX, topFadeMaskStyleFor } from "@/lib/edgeFade";

/// Returns the top fade mask style while `enabled` and the container is
/// scrolled, `undefined` otherwise. `undefined` leaves the element's `style`
/// free of mask properties entirely rather than setting them to `none`.
///
/// Invariant: `ref` must point at a node that mounts together with the calling
/// component. The listener is attached once per `enabled` change, after the
/// commit that assigns refs — a node that appears in a later render of the same
/// component would never be observed.
export function useTopFadeMask(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
): CSSProperties | undefined {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setScrolled(false);
      return;
    }
    const element = ref.current;
    if (!element) return;

    const sync = () => {
      setScrolled(element.scrollTop >= TOP_FADE_SCROLLED_THRESHOLD_PX);
    };
    sync();

    element.addEventListener("scroll", sync, { passive: true });
    return () => {
      element.removeEventListener("scroll", sync);
    };
  }, [ref, enabled]);

  return topFadeMaskStyleFor(enabled, scrolled ? TOP_FADE_SCROLLED_THRESHOLD_PX : 0);
}
