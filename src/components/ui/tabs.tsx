import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Tabs as TabsPrimitive } from "radix-ui"
import { ChromePlate } from "./chrome-control"

// shadcn/ui Tabs (registry, 03.10.2026) with one variant of Mine's own:
// `chrome`, the segmented control of the chrome rows (DESIGN_SYSTEM.md,
// «Вкладки хрома»). `default` and `line` stay as the registry drew them.

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

/** The list's variant, for its triggers. */
const TabsListVariantContext = React.createContext<TabsListVariant>("default")

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-[orientation=horizontal]/tabs:h-9 group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
        // As tall as the row; the 24px plate behind lights on hover, the
        // segments sit 2px inside it.
        chrome:
          "chrome-control relative shrink-0 rounded-1 bg-transparent p-0 px-[2px] font-mono text-sm group-data-[orientation=horizontal]/tabs:h-[var(--chrome-row-content-height)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  plate = "hover",
  children,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants> & {
    /** chrome: the 24px plate behind the list, on hover only or always. */
    plate?: "hover" | "always"
  }) {
  const resolved = variant ?? "default"
  return (
    <TabsListVariantContext.Provider value={resolved}>
      <TabsPrimitive.List
        data-slot="tabs-list"
        data-variant={resolved}
        className={cn(tabsListVariants({ variant: resolved }), className)}
        {...props}
      >
        {resolved === "chrome" && (
          <ChromePlate
            aria-hidden="true"
            data-tabs-plate={plate}
            className={cn(
              "pointer-events-none absolute inset-x-0 rounded-1",
              plate === "always"
                ? "bg-active"
                : "group-hover/tabs-list:bg-active group-focus-within/tabs-list:bg-active"
            )}
          />
        )}
        {children}
      </TabsPrimitive.List>
    </TabsListVariantContext.Provider>
  )
}

const registryTriggerClasses = cn(
  "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 group-data-[variant=default]/tabs-list:data-[state=active]:shadow-sm group-data-[variant=line]/tabs-list:data-[state=active]:shadow-none dark:text-muted-foreground dark:hover:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:border-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent",
  "data-[state=active]:bg-background data-[state=active]:text-foreground dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 dark:data-[state=active]:text-foreground",
  "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:bottom-[-5px] group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-right-1 group-data-[orientation=vertical]/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-100"
)

// A segment of the chrome control: 20px tall, 1ch of padding round a label,
// square round a 13px icon; the chosen one on the inner fill, as the chrome
// segmented control has it.
const chromeTriggerClasses =
  "relative inline-flex h-5 min-w-5 shrink-0 items-center justify-center gap-1 rounded-[2px] px-[1ch] leading-none whitespace-nowrap text-current outline-none focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-component-fill-inner data-[state=active]:text-foreground has-[>svg:only-child]:px-0 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg.lucide]:size-[13px]"

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
