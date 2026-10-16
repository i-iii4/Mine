// A row that scrolls sideways when its content is wider than it, its edges
// dissolving where content is hidden past them, by the rule the tab bar's
// strip follows (SPEC_SCROLL_EDGE_FADE.md, «Полоса вкладок»;
// `hiddenEdges` and `stripFadeMaskStyle` in src/lib/edgeFade.ts). The bottom
// bar of a narrow window holds its commands in one (SPEC_NARROW_WINDOW.md,
// У13).

import { useCallback, useLayoutEffect, useRef, useState, type HTMLAttributes } from "react";
import { hiddenEdges, stripFadeMaskStyle } from "@/lib/edgeFade";
import { cn } from "@/lib/utils";

/** One row of content that scrolls sideways and dissolves at hidden edges. */
export function FadeScrollRow({ className, style, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const sync = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    const next = hiddenEdges(row.scrollLeft, row.clientWidth, row.scrollWidth);
    setEdges((current) => (current.left === next.left && current.right === next.right ? current : next));
  }, []);

  // The row's width follows the window and its content what it shows.
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return undefined;
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(row);
    for (const child of row.children) observer.observe(child);
    const mutations = new MutationObserver(sync);
    mutations.observe(row, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, [sync]);

  return (
    <div
      {...props}
      ref={rowRef}
      className={cn("flex min-w-0 items-center overflow-x-auto overflow-y-hidden", className)}
      style={{ ...style, ...stripFadeMaskStyle(edges) }}
      onScroll={sync}
      data-fade-left={edges.left ? "true" : undefined}
      data-fade-right={edges.right ? "true" : undefined}
    >
      {children}
    </div>
  );
}
