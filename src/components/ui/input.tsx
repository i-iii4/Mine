import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "file:text-foreground placeholder:text-tertiary-foreground selection:bg-primary selection:text-primary-foreground border-input h-9 w-full min-w-0 rounded-1 border bg-background px-3 py-2 text-base text-foreground outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-base file:font-semibold disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:border-foreground",
        "aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Input }
