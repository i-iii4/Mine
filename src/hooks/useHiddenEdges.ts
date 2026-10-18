// Which edges of a block that scrolls sideways hide content past them, kept
// current while it scrolls, while it or what it holds changes size, and while
// its content changes (SPEC_SCROLL_EDGE_FADE.md, «Полоса вкладок»). The
// narrow window's bottom bar (`FadeScrollRow`, SPEC_NARROW_WINDOW.md, У13) and
// an article table wider than its block (`ArticleTable`, SPEC_READING_MODE.md,
// Ч5.3) dissolve those edges with `stripFadeMaskStyle`. The tab bar's strip
// counts its own: it knows its width from its tabs.

import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { hiddenEdges } from "@/lib/edgeFade";

/** The edges of a sideways scrolling block that hide content past them. */
export type HiddenEdges = ReturnType<typeof hiddenEdges>;

/** What `useHiddenEdges` gives its block. */
export interface HiddenEdgesState {
  edges: HiddenEdges;
  /** Reads the block again; the block's `onScroll`. */
  sync: () => void;
}

/** Follow the hidden edges of the block in `ref`. The state changes only
 *  when an edge crosses the threshold, not on every pixel scrolled; a read
 *  that finds the same edges asks React for nothing. */
export function useHiddenEdges(ref: RefObject<HTMLElement | null>): HiddenEdgesState {
  const [edges, setEdges] = useState<HiddenEdges>({ left: false, right: false });
  const shown = useRef(edges);

  const sync = useCallback(() => {
    const block = ref.current;
    if (!block) return;
    const next = hiddenEdges(block.scrollLeft, block.clientWidth, block.scrollWidth);
    if (shown.current.left === next.left && shown.current.right === next.right) return;
    shown.current = next;
    setEdges(next);
  }, [ref]);

  // The block's width follows the window and its content what it shows.
  useLayoutEffect(() => {
    const block = ref.current;
    if (!block) return undefined;
    sync();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    resize?.observe(block);
    for (const child of block.children) resize?.observe(child);
    const mutations = new MutationObserver(sync);
    mutations.observe(block, { childList: true, subtree: true, characterData: true });
    return () => {
      resize?.disconnect();
      mutations.disconnect();
    };
  }, [ref, sync]);

  return { edges, sync };
}
