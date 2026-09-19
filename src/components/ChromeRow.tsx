import { forwardRef, type HTMLAttributes } from "react";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

interface ChromeRowProps extends HTMLAttributes<HTMLDivElement> {
  as?: "div" | "header";
  separator: "top" | "bottom";
}

/** Shared content geometry; the separator is a sibling, never an overlay. */
export const ChromeRow = forwardRef<HTMLDivElement, ChromeRowProps>(
  ({ as: Element = "div", separator, className, children, ...props }, ref) => (
    <>
      {separator === "top" && <Separator data-chrome-divider="" />}
      <Element
        {...props}
        ref={ref}
        data-chrome-separator={separator}
        className={cn("chrome-row flex shrink-0 items-center", className)}
      >
        {children}
      </Element>
      {separator === "bottom" && <Separator data-chrome-divider="" />}
    </>
  ),
);
ChromeRow.displayName = "ChromeRow";

/** Own the two outer boundaries once, independently of native decorations. */
export function ChromeShell({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} data-chrome-shell="" className={cn("flex h-screen w-screen flex-col bg-background text-foreground", className)}>
      <Separator data-chrome-frame-edge="top" />
      {children}
      <Separator data-chrome-frame-edge="bottom" />
    </div>
  );
}
