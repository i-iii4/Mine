import { forwardRef, type HTMLAttributes, type ComponentProps } from "react";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

interface ChromeRowProps extends HTMLAttributes<HTMLDivElement> {
  as?: "div" | "header";
  separator: "top" | "bottom";
  separatorProps?: ComponentProps<typeof Separator> & { "data-entered"?: string };
}

/** Shared content geometry; the separator is a sibling, never an overlay. */
export const ChromeRow = forwardRef<HTMLDivElement, ChromeRowProps>(
  ({ as: Element = "div", separator, separatorProps, className, children, ...props }, ref) => (
    <>
      {separator === "top" && <Separator data-chrome-divider="" {...separatorProps} />}
      <Element
        {...props}
        ref={ref}
        data-chrome-separator={separator}
        className={cn("chrome-row flex shrink-0 items-center", className)}
      >
        {children}
      </Element>
      {separator === "bottom" && <Separator data-chrome-divider="" {...separatorProps} />}
    </>
  ),
);
ChromeRow.displayName = "ChromeRow";

/** Shared action spacing. The edge inset includes the icon's inner 4px padding. */
export function ChromeActions({ windowEdge = true, className, ...props }: HTMLAttributes<HTMLDivElement> & { windowEdge?: boolean }) {
  return <div data-chrome-actions="" className={cn("flex shrink-0 items-center gap-1", windowEdge && "mr-[var(--chrome-icon-edge-pad)]", className)} {...props} />;
}

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
