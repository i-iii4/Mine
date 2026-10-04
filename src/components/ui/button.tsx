import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"
import { ChromeControl, ChromePlate } from "./chrome-control"
import { Tooltip, TooltipContent, TooltipShortcut, TooltipTrigger } from "./tooltip"

/** Sizes that hold a glyph and no text: such a button names itself in a
 *  tooltip (decision of 03.10.2026). */
const ICON_SIZES = new Set(["icon", "icon-xs", "chrome-icon"])

/** How long the pointer rests before the first tooltip; the next ones open
 *  at once while the pointer moves between buttons (the provider's skip). */
const TOOLTIP_DELAY_MS = 500

// Keyboard focus draws the `--ring` outline inside the edge, the same inset
// line hover uses (DESIGN_SYSTEM.md, Focus (button)); only chrome controls
// show focus through their plate instead.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-1 text-base font-semibold select-none text-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-[13px] shrink-0 [&_svg]:shrink-0 focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ring",
  {
    variants: {
      variant: {
        // Filled and raised with depth, no hover (DESIGN_SYSTEM.md,
        // «Объём кнопки»).
        default: "button-depth rounded-2 bg-depth-fill",
        // Secondary action: transparent body, permanent border. Text action
        // buttons are never borderless — ghost is reserved for icon controls.
        secondary: "bg-transparent outline-1 -outline-offset-1 outline-border hover:outline-component-fill-hover",
        destructive: "button-depth rounded-2 bg-depth-fill text-destructive",
        // A keystroke that cannot be pressed: `secondary`'s body — transparent,
        // permanent border — with no hover at all. The outline keeps it a
        // control by shape; the missing fill and missing hover say it is a
        // reference, not a button.
        reference: "bg-transparent outline-1 -outline-offset-1 outline-border",
        ghost: "bg-transparent hover:text-hover-foreground",
        chrome: "group/chrome bg-transparent text-muted-foreground hover:text-foreground data-[state=open]:text-foreground focus-visible:text-foreground focus-visible:outline-none",
        // The card's button: filled with depth like `default`, a dimmed glyph
        // that brightens while its menu is open; no hover (DESIGN_SYSTEM.md,
        // «Кнопки карточки»).
        raised: "button-depth rounded-2 bg-depth-fill text-muted-foreground data-[state=open]:text-foreground",
        link: "bg-transparent underline underline-offset-4 hover:text-hover-foreground",
      },
      size: {
        default: "h-8 px-3 has-[>svg]:px-2.5",
        clipper: "h-10 px-3 has-[>svg]:px-2.5",
        sm: "h-7 px-2.5 has-[>svg]:px-2 [&_svg:not([class*='size-'])]:size-[13px]",
        xs: "h-6 gap-1 px-2 text-sm has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-[13px]",
        icon: "size-8",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-[13px]",
        "chrome-icon": "w-6 p-0 [&_svg.lucide]:size-[13px] [&_svg:not(.lucide)]:size-4",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  plate = "hover",
  tooltip,
  shortcut,
  children,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /** chrome-icon: the 24px plate on hover only, or always (the sidebar's
     *  filter row, DESIGN_SYSTEM.md, «Иконочные кнопки хрома»). */
    plate?: "hover" | "always"
    /** What the tooltip says. An icon button says its `aria-label` unless
     *  given this; `false` keeps it silent (a page too small to show one). */
    tooltip?: React.ReactNode | false
    /** The keystroke that does the same, shown beside the tooltip's text. */
    shortcut?: string
  }) {
  const Comp = asChild ? Slot.Root : "button"
  const label = props["aria-label"]
  const tip =
    tooltip === false
      ? null
      : tooltip ?? (!asChild && ICON_SIZES.has(size ?? "") && typeof label === "string" ? label : null)

  const button = (
    <ChromeControl enabled={size === "chrome-icon"}>
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {size === "chrome-icon" && !asChild ? (
        <ChromePlate
          data-plate={plate}
          className={cn(
            "w-6 rounded-1",
            plate === "always"
              ? "bg-active"
              : "group-hover/chrome:bg-active group-data-[state=open]/chrome:bg-active group-data-[top-chrome-keyboard-focus=true]/chrome:bg-active group-focus-visible/chrome:bg-active",
          )}
        >
          {children}
        </ChromePlate>
      ) : children}
    </Comp>
    </ChromeControl>
  )
  if (tip === null) return button
  return (
    <Tooltip delayDuration={TOOLTIP_DELAY_MS}>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>
        {tip}
        {shortcut && <TooltipShortcut>{shortcut}</TooltipShortcut>}
      </TooltipContent>
    </Tooltip>
  )
}

export { Button, buttonVariants }
