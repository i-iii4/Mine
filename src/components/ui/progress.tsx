import * as React from "react"
import { Progress as ProgressPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * Progress bar of the design system (DESIGN_SYSTEM.md «Progress»): track and
 * fill rounded like the rest of the interface, 3px. With a `value` it is
 * determinate; with `null` it shows work whose length is unknown: a segment
 * slides across the track (`mine-progress-indeterminate` in global.css), and
 * under reduced motion it stays in place and breathes instead.
 */
function Progress({
  className,
  indicatorClassName,
  value,
  ...props
}: Omit<React.ComponentProps<typeof ProgressPrimitive.Root>, "value"> & {
  value: number | null
  indicatorClassName?: string
}) {
  const indeterminate = value === null
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      data-progress-mode={indeterminate ? "indeterminate" : "determinate"}
      value={value}
      className={cn(
        "bg-primary/20 relative h-2 w-full overflow-hidden rounded-1",
        className
      )}
      {...props}
    >
      {indeterminate ? (
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className={cn(
            "mine-progress-indeterminate bg-primary absolute inset-y-0 left-0 w-1/3 rounded-1",
            indicatorClassName
          )}
        />
      ) : (
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className={cn(
            "bg-primary h-full w-full rounded-1 transition-transform duration-300 ease-out",
            indicatorClassName
          )}
          style={{ transform: `translateX(-${100 - Math.min(100, Math.max(0, value))}%)` }}
        />
      )}
    </ProgressPrimitive.Root>
  )
}

export { Progress }
