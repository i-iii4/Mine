// Top-edge fade activation for a scroll container.
//
// The mask is only meaningful once content has actually travelled up under the
// chrome: at rest the first row must stay fully opaque. The hook therefore
// tracks a single boolean — "is this surface scrolled" — instead of a scroll
// offset, so ordinary scrolling produces no re-render once the mask is on.
//
// Attachment goes through a callback ref rather than a ref object. Surfaces
// like the search overlay live inside a Radix `Dialog`, which does not mount
// its content until the dialog opens, so the scroll container appears in a
// later render than the component itself. A ref object would still be empty
// when the effect ran, and the effect would never re-run — those surfaces would
// silently never fade.

import { useCallback, useEffect, useState, type CSSProperties, type RefObject } from "react";
import {
  TOP_FADE_SCROLLED_THRESHOLD_PX,
  topFadeMaskStyleFor,
  type TopFadeVariant,
} from "@/lib/edgeFade";

export interface TopFadeMask {
  /// Attach to the scroll container. Also populates the caller's own ref, so a
  /// surface that already needs the node for focus or scrolling keeps working.
  ref: (node: HTMLElement | null) => void;
  /// Mask style while enabled and scrolled, `undefined` otherwise. `undefined`
  /// leaves the element's `style` free of mask properties rather than setting
  /// them to `none`.
  style: CSSProperties | undefined;
}

/// Dissolve a scroll container's top edge once it is scrolled.
///
/// `forwardRef` is the caller's existing ref for the same node, kept in sync so
/// this hook can be added to a surface without disturbing what already uses it.
export function useTopFadeMask(
  forwardRef: RefObject<HTMLElement | null> | undefined,
  enabled: boolean,
  variant: TopFadeVariant,
): TopFadeMask {
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

  return {
    ref,
    style: topFadeMaskStyleFor(enabled, scrolled ? TOP_FADE_SCROLLED_THRESHOLD_PX : 0, variant),
  };
}
