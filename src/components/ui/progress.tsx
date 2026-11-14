import * as React from "react"
import { Progress as ProgressPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * Progress bar of the design system (DESIGN_SYSTEM.md «Progress»): track and
 * fill are plain rectangles, no rounding. With a `value` it is
 * determinate; with `null` it shows work whose length is unknown: a segment
 * slides across the track (`mine-progress-indeterminate` in global.css), and
 * at the level Off it stays in place and breathes instead. The fill moves to
 * a new value as Перемещение: 200 ms in Full, 150 ms in Minimal, on the move
 * curve, at once in Off (SPEC_MOTION_LEVELS.md, З1, З2, РД1).
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
        "bg-primary/20 relative h-2 w-full overflow-hidden",
        className
      )}
      {...props}
    >
      {indeterminate ? (
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className={cn(
            "mine-progress-indeterminate bg-primary absolute inset-y-0 left-0 w-1/3",
            indicatorClassName
          )}
        />
      ) : (
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className={cn(
            // The fill follows the work on its own time, outside the roles
            // (global.css, `.mine-progress-fill`; SPEC_MOTION_LEVELS.md, З2).
            "mine-progress-fill bg-primary h-full w-full",
            indicatorClassName
          )}
          style={{ transform: `translateX(-${100 - Math.min(100, Math.max(0, value))}%)` }}
        />
      )}
    </ProgressPrimitive.Root>
  )
}

export { Progress }
