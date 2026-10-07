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

/** What a button holds: pressed as a toggle, or its own menu, popover or
 *  picker open (Radix triggers pass `aria-expanded` and `data-state` down to
 *  the button they wrap). */
type HeldState = {
  "aria-pressed"?: React.AriaAttributes["aria-pressed"]
  "aria-expanded"?: React.AriaAttributes["aria-expanded"]
  "data-state"?: string
}

/** A held button says nothing: what it names is already in front of the
 *  person (DESIGN_SYSTEM.md, «Подсказки»; user's decision of 07.10.2026). */
function isHeld(props: HeldState): boolean {
  return props["aria-pressed"] === true || props["aria-pressed"] === "true"
    || props["aria-expanded"] === true || props["aria-expanded"] === "true"
    || props["data-state"] === "open" || props["data-state"] === "on"
}

// Keyboard focus draws the `--ring` outline inside the edge, the same inset
// line hover uses (DESIGN_SYSTEM.md, Focus (button)); only chrome controls
// show focus through their plate instead.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-1 text-base font-normal select-none text-foreground disabled:pointer-events-none disabled:text-tertiary-foreground [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-[13px] shrink-0 [&_svg]:shrink-0 focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ring",
  {
    variants: {
      variant: {
        // Filled and raised with depth (DESIGN_SYSTEM.md, «Объём кнопки»).
        // Disabled, it keeps only the frame (global.css, «Недоступно»).
        default: "button-depth bg-depth-fill",
        // Secondary action: transparent body, permanent border. Text action
        // buttons are never borderless — ghost is reserved for icon controls.
        secondary: "bg-transparent outline-1 -outline-offset-1 outline-border hover:outline-component-fill-hover disabled:outline-inert-frame",
        destructive: "button-depth bg-depth-fill text-destructive",
        // Something that reports and cannot be pressed (a keystroke the bottom
        // bar names, the Connected plaque): the frame every unpressable control
        // shares, from the surface under it, and the secondary step, since what
        // it names works. No hover at all. Disabled controls share the frame
        // but take the tertiary step (DESIGN_SYSTEM.md, «Недоступно»).
        reference: "bg-transparent outline-1 -outline-offset-1 outline-inert-frame text-muted-foreground",
        ghost: "bg-transparent hover:text-foreground",
        chrome: "group/chrome bg-transparent text-muted-foreground hover:text-foreground data-[state=open]:text-foreground focus-visible:text-foreground focus-visible:outline-none",
        // The card's button: filled with depth like `default`, a dimmed glyph
        // at rest. Hover lays the state layer over the face, like every
        // button with depth (buttons.css), and brightens the text and the
        // glyph a step, as every button does on hover; a press and an open
        // menu hold them there (SPEC_COLOR_RULES.md, 3.6; DESIGN_SYSTEM.md,
        // «Кнопки карточки»; user's decision of 07.10.2026).
        raised: "button-depth bg-depth-fill text-muted-foreground hover:text-foreground active:text-foreground data-[state=open]:text-foreground",
        link: "bg-transparent underline underline-offset-4 hover:text-foreground",
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
  VariantProps<typeof buttonVariants> &
  HeldState & {
    asChild?: boolean
    /** chrome-icon: the 24px plate on hover only, always (the sidebar's
     *  filter row, DESIGN_SYSTEM.md, «Иконочные кнопки хрома»), or raised:
     *  filled with depth like the card's buttons; hover lays the state
     *  layer over the plate's face and brightens the glyph as on every
     *  chrome button (DESIGN_SYSTEM.md, «Объём кнопки»). */
    plate?: "hover" | "always" | "raised"
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
  // The tooltip is held shut while the button is held, and one already open
  // when that happens closes and stays closed until the pointer or focus
  // brings it again.
  const held = isHeld(props)
  const [tipOpen, setTipOpen] = React.useState(false)
  const [wasHeld, setWasHeld] = React.useState(held)
  if (held !== wasHeld) {
    setWasHeld(held)
    if (held) setTipOpen(false)
  }

  const button = (
    <ChromeControl enabled={size === "chrome-icon"}>
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      // Every chrome icon button brightens its glyph to the primary step on
      // hover, a raised plate's included (SPEC_COLOR_RULES.md, 3.6; user's
      // report of 07.10.2026: a dimmed glyph on a lit raised plate read
      // weaker than a plain chrome button's).
      className={buttonVariants({ variant, size, className })}
      {...props}
    >
      {size === "chrome-icon" && !asChild ? (
        <ChromePlate
          data-plate={plate}
          className={cn(
            "w-6 rounded-1",
            plate === "raised"
              ? "button-depth bg-depth-fill"
              : plate === "always"
                ? "state-active"
                : "group-hover/chrome:state-active group-data-[state=open]/chrome:state-active group-data-[top-chrome-keyboard-focus=true]/chrome:state-active group-focus-visible/chrome:state-active",
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
    <Tooltip
      delayDuration={TOOLTIP_DELAY_MS}
      open={tipOpen && !held}
      onOpenChange={(next) => setTipOpen(next && !held)}
    >
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>
        {tip}
        {shortcut && <TooltipShortcut>{shortcut}</TooltipShortcut>}
      </TooltipContent>
    </Tooltip>
  )
}

export { Button, buttonVariants }
