import type { ComponentProps, HTMLAttributes, ReactElement } from "react";
import { Slot } from "radix-ui";
import { cn } from "@/lib/utils";

/** Extend the existing interactive element, not a second clickable wrapper. */
export function ChromeControl({ children, enabled = true, className, ...props }: ComponentProps<typeof Slot.Root> & { children: ReactElement; enabled?: boolean }) {
  return <Slot.Root {...props} data-chrome-control={enabled ? "" : undefined} className={cn(enabled && "chrome-control", className)}>{children}</Slot.Root>;
}

/** The visible plate is independent of the full-row hit target. */
export function ChromePlate({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span data-chrome-plate="" className={cn("chrome-plate inline-flex shrink-0 items-center justify-center", className)} {...props} />;
}
