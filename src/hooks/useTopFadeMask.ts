// Tracks whether a scroll container is scrolled, so its surface can show the
// band that continues the chrome over the content.
//
// The band is only meaningful once content has actually travelled under the
// chrome: at rest there is nothing to continue over. The hook therefore tracks a
// single boolean rather than a scroll offset, so ordinary scrolling produces no
// re-render once the band is up.
//
// Attachment goes through a callback ref rather than a ref object. Surfaces like
// the search overlay live inside a Radix `Dialog`, which does not mount its
// content until the dialog opens: the scroll container appears in a later render
// than the component itself. A ref object would still be empty when the effect
// ran, and the effect would never re-run, so those surfaces would silently never
// show the band.

import { useCallback, useEffect, useState, type RefObject } from "react";
import { TOP_FADE_SCROLLED_THRESHOLD_PX } from "@/lib/edgeFade";

export interface TopFadeState {
  /// Attach to the scroll container. Also populates the caller's own ref, so a
  /// surface that already needs the node for focus or scrolling keeps working.
  ref: (node: HTMLElement | null) => void;
  /// Whether the surface is scrolled far enough to show the band.
  active: boolean;
}

/// Watch a scroll container for the top fade band.
///
/// `forwardRef` is the caller's existing ref for the same node, kept in sync so
/// this hook can be added to a surface without disturbing what already uses it.
export function useTopFadeMask(
  forwardRef: RefObject<HTMLElement | null> | undefined,
  enabled: boolean,
): TopFadeState {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [scrolled, setScrolled] = useState(false);

  const ref = useCallback(
    (next: HTMLElement | null) => {
      if (forwardRef) forwardRef.current = next;
      setNode(next);
    },
    [forwardRef],
  );

  useEffect(() => {
    if (!enabled || !node) {
      setScrolled(false);
      return;
    }

    const sync = () => {
      setScrolled(node.scrollTop >= TOP_FADE_SCROLLED_THRESHOLD_PX);
    };
    sync();

    node.addEventListener("scroll", sync, { passive: true });
    return () => {
      node.removeEventListener("scroll", sync);
    };
  }, [node, enabled]);

  return { ref, active: enabled && scrolled };
}
