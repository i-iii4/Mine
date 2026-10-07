import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex h-7 w-fit shrink-0 select-none items-center justify-center gap-1 overflow-hidden rounded-pill border border-transparent px-3 py-1 text-base whitespace-nowrap outline-0 outline-transparent [&>svg]:pointer-events-none [&>svg]:size-[13px]",
  {
    variants: {
      variant: {
        default:
          "bg-primary font-semibold text-primary-foreground [a&]:hover:bg-primary/90",
        secondary:
          "bg-secondary font-semibold text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive:
          "bg-destructive font-semibold text-white [a&]:hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "border-border bg-component-fill font-semibold text-foreground",
        ghost:
          "font-semibold [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        link:
          "font-semibold text-primary underline-offset-4 [a&]:hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
