// Tracks whether a scroll container is scrolled, so its surface can show the
// band that continues the chrome over the content.
//
// The band is only meaningful once content has actually travelled under the
// chrome: at rest there is nothing to continue over. It then grows with the
// scroll until it reaches the profile maximum, after which the value is constant
// and ordinary scrolling stops re-rendering.
//
// Attachment goes through a callback ref rather than a ref object. Surfaces like
// the search overlay live inside a Radix `Dialog`, which does not mount its
// content until the dialog opens: the scroll container appears in a later render
// than the component itself. A ref object would still be empty when the effect
// ran, and the effect would never re-run, so those surfaces would silently never
// show the band.

import { useCallback, useEffect, useState, type RefObject } from "react";
import { topFadeHeight, type TopFadeProfile } from "@/lib/edgeFade";

export interface TopFadeState {
  /// Attach to the scroll container. Also populates the caller's own ref, so a
  /// surface that already needs the node for focus or scrolling keeps working.
  ref: (node: HTMLElement | null) => void;
  /// Band height in CSS pixels; `0` while the surface is at rest or the
  /// preference is off.
  height: number;
}

/// Watch a scroll container for the top fade band.
///
/// `forwardRef` is the caller's existing ref for the same node, kept in sync so
/// this hook can be added to a surface without disturbing what already uses it.
export function useTopFadeMask(
  forwardRef: RefObject<HTMLElement | null> | undefined,
  enabled: boolean,
  profile: TopFadeProfile,
): TopFadeState {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [height, setHeight] = useState(0);

  const ref = useCallback(
    (next: HTMLElement | null) => {
      if (forwardRef) forwardRef.current = next;
      setNode(next);
    },
    [forwardRef],
  );

  useEffect(() => {
    if (!enabled || !node) {
      setHeight(0);
      return;
    }

    // Once the band reaches its maximum this settles on a constant, so further
    // scrolling stops re-rendering.
    const sync = () => {
      setHeight(topFadeHeight(true, node.scrollTop, profile));
    };
    sync();

    node.addEventListener("scroll", sync, { passive: true });
    return () => {
      node.removeEventListener("scroll", sync);
    };
  }, [node, enabled, profile]);

  return { ref, height };
}
