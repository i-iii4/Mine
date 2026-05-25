import * as React from "react"

import { cn } from "@/lib/utils"

function Input({
  className,
  type,
  variant = "default",
  controlSize = "default",
  ...props
}: React.ComponentProps<"input"> & {
  variant?: "default" | "ghost"
  controlSize?: "default" | "clipper"
}) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "placeholder:text-tertiary-foreground selection:bg-primary selection:text-primary-foreground w-full min-w-0 rounded-1 px-3 py-2 text-base text-foreground outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        controlSize === "clipper" ? "h-10" : "h-8",
        variant === "default" && [
          "border-input border bg-background",
          "focus-visible:border-foreground",
          "aria-invalid:border-destructive",
          "file:text-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-base file:font-semibold",
        ],
        variant === "ghost" && "border-none bg-transparent",
        className
      )}
      {...props}
    />
  )
}

export { Input }
