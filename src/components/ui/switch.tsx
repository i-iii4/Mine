import * as React from "react"
import { cn } from "@/lib/utils"
import { Switch as SwitchPrimitive } from "radix-ui"

// shadcn/ui Switch (registry, 03.10.2026). Mine adds the `chrome` size, a
// 24 x 14 track that sits in a chrome row beside 13px text, and the
// `square` shape on the radius tokens, to compare with the round one
// (Top Bar Variants in the settings window).

function Switch({
  className,
  size = "default",
  shape = "round",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default" | "chrome"
  shape?: "round" | "square"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      data-shape={shape}
      className={cn(
        "peer group/switch inline-flex shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-[1.15rem] data-[size=default]:w-8 data-[size=sm]:h-3.5 data-[size=sm]:w-6 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-input/80",
        "data-[size=chrome]:h-3.5 data-[size=chrome]:w-6 data-[size=chrome]:px-px data-[size=chrome]:shadow-none data-[size=chrome]:focus-visible:ring-0 data-[size=chrome]:focus-visible:outline-1 data-[size=chrome]:focus-visible:outline-ring",
        "data-[shape=square]:rounded-1",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block rounded-full bg-background ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0 dark:data-[state=checked]:bg-primary-foreground dark:data-[state=unchecked]:bg-foreground",
          "group-data-[size=chrome]/switch:size-2.5 group-data-[size=chrome]/switch:data-[state=checked]:translate-x-2.5",
          "group-data-[shape=square]/switch:rounded-[2px]"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
