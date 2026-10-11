// A label of a chrome strip: one line that dissolves at its right edge when it
// does not fit, instead of ending in an ellipsis (DESIGN_SYSTEM.md,
// «Растворение кромок»; user's decision of 11.10.2026: one surface, one way).
// The tab bar's tabs, the path of the top row and the clipper's header use it;
// menus, search results and lists keep their ellipsis.
//
// Whether the text fits is measured, since the dissolve must not eat the end
// of a label that does. The mask itself is global.css's `[data-fade-text]`
// rule, on this element alone: a hover plate, a chevron or a button beside
// the text stays whole.

import {
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type RefObject,
} from "react";
import { cn } from "@/lib/utils";

/** Whether the element's text runs past its box, measured by `scrollWidth`
 *  on every change of the text and every resize of the element: a window,
 *  sidebar or tab narrowing the label measures it again. */
export function useTextOverflow(ref: RefObject<HTMLElement | null>, text: string): boolean {
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setOverflow(node.scrollWidth > node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, text]);
  return overflow;
}

interface FadeTextProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  text: string;
}

/** One line of `text` as a flex item that may shrink: it clips what does not
 *  fit and dissolves it over the last 24px. */
export function FadeText({ text, className, ...props }: FadeTextProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const overflow = useTextOverflow(ref, text);
  return (
    <span
      ref={ref}
      data-fade-text=""
      data-overflow={overflow ? "true" : undefined}
      className={cn("min-w-0 overflow-hidden whitespace-nowrap", className)}
      {...props}
    >
      {text}
    </span>
  );
}
