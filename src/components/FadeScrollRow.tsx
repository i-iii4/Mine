// A row that scrolls sideways when its content is wider than it, its edges
// dissolving where content is hidden past them, by the rule the tab bar's
// strip follows (SPEC_SCROLL_EDGE_FADE.md, «Полоса вкладок»;
// `hiddenEdges` and `stripFadeMaskStyle` in src/lib/edgeFade.ts, followed by
// `useHiddenEdges`). The bottom bar of a narrow window holds its commands in
// one (SPEC_NARROW_WINDOW.md, У13).

import { useRef, type HTMLAttributes } from "react";
import { stripFadeMaskStyle } from "@/lib/edgeFade";
import { useHiddenEdges } from "@/hooks/useHiddenEdges";
import { cn } from "@/lib/utils";

/** One row of content that scrolls sideways and dissolves at hidden edges. */
export function FadeScrollRow({ className, style, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  const rowRef = useRef<HTMLDivElement>(null);
  const { edges, sync } = useHiddenEdges(rowRef);

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
