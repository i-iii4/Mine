import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Tabs as TabsPrimitive } from "radix-ui"

// shadcn/ui Tabs (registry, 03.10.2026) with one variant of Mine's own:
// `chrome`, the pill every segmented switch of the app is (DESIGN_SYSTEM.md,
// «Пилюля»). `default` and `line` stay as the registry drew them.

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-[orientation=horizontal]:flex-col",
        className
      )}
      {...props}
    />
  )
}

type TabsListVariant = "default" | "line" | "chrome"
/** The pill's size: `row` stands in a chrome row (a 24px pill on the row's
 *  height), `panel` in the settings window and the clipper (a 32px pill). */
type TabsListSize = "row" | "panel"

/** The list's variant, for its triggers. */
const TabsListVariantContext = React.createContext<TabsListVariant>("default")

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-[orientation=horizontal]/tabs:h-9 group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
        // The pill: a track and the chosen segment's button seated flush in
        // it (user's decision of 07.10.2026, DESIGN_SYSTEM.md, «Пилюля»).
        // The track is the hover plate's own state layer; the button steps
        // from the surface under the pill, a quarter s brighter than the
        // track, not from the track, so nothing stacks twice. The list
        // passes no surface on.
        chrome: "relative shrink-0 rounded-1 bg-transparent p-0",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

const pillSizeClasses: Record<TabsListSize, string> = {
  row: "chrome-control [--tabs-pill-height:var(--chrome-control-plate-height)] font-mono text-sm group-data-[orientation=horizontal]/tabs:h-[var(--chrome-row-content-height)]",
  panel: "[--tabs-pill-height:32px] text-base group-data-[orientation=horizontal]/tabs:h-[var(--tabs-pill-height)]",
}

/** Where the chosen segment's button stands, and whether it moves there. */
type IndicatorBox = { x: number; width: number; animate: boolean }

/**
 * The chosen segment's button follows the chosen trigger: placed at once on
 * the first frame and when the pill's width changes, slid there when the
 * choice changes. The choice is read from the triggers' `data-state`, so a
 * controlled and an uncontrolled `Tabs` move it alike.
 */
function useChosenSegment(list: HTMLElement | null): IndicatorBox | null {
  const [box, setBox] = React.useState<IndicatorBox | null>(null)
  React.useLayoutEffect(() => {
    if (!list) return
    const place = (animate: boolean) => {
      const chosen = list.querySelector<HTMLElement>(
        ':scope > [data-slot="tabs-trigger"][data-state="active"]'
      )
      // Rects, not offsetLeft and offsetWidth: those round to whole pixels,
      // and a label's width is fractional, so a rounded button stops short
      // of the track's far edge.
      const segment = chosen?.getBoundingClientRect()
      const next = chosen && segment
        ? { x: segment.left - list.getBoundingClientRect().left, width: segment.width, animate }
        : null
      setBox((current) =>
        current && next && current.x === next.x && current.width === next.width && current.animate === next.animate
          ? current
          : next
      )
    }
    place(false)
    const choice = new MutationObserver(() => place(true))
    choice.observe(list, { subtree: true, attributes: true, attributeFilter: ["data-state"] })
    const size = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => place(false))
    size?.observe(list)
    return () => {
      choice.disconnect()
      size?.disconnect()
    }
  }, [list])
  return box
}

function TabsList({
  className,
  variant = "default",
  size = "row",
  children,
  ref,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants> & {
    /** chrome: the pill's size. */
    size?: TabsListSize
  }) {
  const resolved = variant ?? "default"
  const [list, setList] = React.useState<HTMLDivElement | null>(null)
  const setRefs = React.useCallback(
    (node: HTMLDivElement | null) => {
      setList(node)
      if (typeof ref === "function") ref(node)
      else if (ref) ref.current = node
    },
    [ref]
  )
  const chosen = useChosenSegment(resolved === "chrome" ? list : null)
  return (
    <TabsListVariantContext.Provider value={resolved}>
      <TabsPrimitive.List
        ref={setRefs}
        data-slot="tabs-list"
        data-variant={resolved}
        data-size={resolved === "chrome" ? size : undefined}
        className={cn(
          tabsListVariants({ variant: resolved }),
          resolved === "chrome" && pillSizeClasses[size],
          className,
        )}
        {...props}
      >
        {resolved === "chrome" && (
          <>
            <span
              aria-hidden="true"
              data-tabs-track=""
              className="pointer-events-none absolute inset-x-0 h-[var(--tabs-pill-height)] rounded-1 state-active"
            />
            {/* The chosen segment's button: flush with the track, as tall
                as the pill, over its own share of it. A button with depth
                whose face is the pill's own step (from the surface under
                the pill, 1¼ s in light and 1¾ s in dark, no state layer),
                so the button style's edges follow that face. It slides to
                a new choice in 150ms (a strong ease-out); with reduced
                motion it moves at once. */}
            <span
              aria-hidden="true"
              data-tabs-indicator=""
              data-animate={chosen?.animate ? "" : undefined}
              className={cn(
                "pointer-events-none absolute left-0 h-[var(--tabs-pill-height)] rounded-1 bg-component-fill-inner",
                "[--button-face-step:var(--pill-chosen-elevation)] [--button-face-layer:none] [--button-face-share:0%]",
                "motion-safe:data-[animate]:transition-[transform,width] motion-safe:data-[animate]:duration-150 motion-safe:data-[animate]:ease-[cubic-bezier(0.23,1,0.32,1)]",
                !chosen && "hidden",
              )}
              style={chosen ? { width: chosen.width, transform: `translateX(${chosen.x}px)` } : undefined}
            />
          </>
        )}
        {children}
      </TabsPrimitive.List>
    </TabsListVariantContext.Provider>
  )
}

const registryTriggerClasses = cn(
  "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-normal whitespace-nowrap text-foreground/60 transition-all group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 group-data-[variant=default]/tabs-list:data-[state=active]:shadow-sm group-data-[variant=line]/tabs-list:data-[state=active]:shadow-none dark:text-muted-foreground dark:hover:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:border-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent",
  "data-[state=active]:bg-background data-[state=active]:text-foreground dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 dark:data-[state=active]:text-foreground",
  "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:bottom-[-5px] group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-right-1 group-data-[orientation=vertical]/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-100"
)

// A segment of the pill: as tall as the pill, 1ch of padding round a label,
// square round a 13px icon. The chosen segment's button is drawn by the list
// under it; a segment shows only its text: the secondary step, the primary
// when chosen or under the pointer.
const chromeTriggerClasses =
  "relative inline-flex h-[var(--tabs-pill-height)] min-w-[var(--tabs-pill-height)] shrink-0 items-center justify-center gap-1 rounded-1 px-[1ch] leading-none whitespace-nowrap text-muted-foreground outline-none motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out hover:text-foreground focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ring disabled:pointer-events-none disabled:text-tertiary-foreground data-[state=active]:text-foreground has-[>svg:only-child]:px-0 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg.lucide]:size-[13px]"

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  const variant = React.useContext(TabsListVariantContext)
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(variant === "chrome" ? chromeTriggerClasses : registryTriggerClasses, className)}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
