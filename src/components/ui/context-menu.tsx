import * as React from "react"
import { CheckIcon, ChevronRightIcon } from "lucide-react"
import { ContextMenu as ContextMenuPrimitive } from "radix-ui"

import { MenuIconSlot } from "@/components/ui/menu-icon-slot"
import { FLOATING_LAYER_EDGE_PX } from "@/lib/floatingLayer"
import { cn } from "@/lib/utils"

type FloatingMenuWidthRole = "command" | "selector" | "picker"

function ContextMenu({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
}

function ContextMenuTrigger({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return (
    <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
  )
}

function ContextMenuGroup({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Group>) {
  return (
    <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />
  )
}

function ContextMenuPortal({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Portal>) {
  return (
    <ContextMenuPrimitive.Portal data-slot="context-menu-portal" {...props} />
  )
}

function ContextMenuSub({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Sub>) {
  return <ContextMenuPrimitive.Sub data-slot="context-menu-sub" {...props} />
}

function ContextMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioGroup>) {
  return (
    <ContextMenuPrimitive.RadioGroup
      data-slot="context-menu-radio-group"
      {...props}
    />
  )
}

function ContextMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.SubTrigger
      data-slot="context-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "focus:state-active focus:text-foreground data-[state=open]:state-active data-[state=open]:text-foreground [&_svg:not([class*='text-'])]:text-muted-foreground focus:[&_svg:not([class*='text-'])]:text-foreground data-[state=open]:[&_svg:not([class*='text-'])]:text-foreground flex cursor-default items-center gap-2 rounded-1 px-2 py-1.5 text-base outline-hidden select-none data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[13px]",
        className
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto" />
    </ContextMenuPrimitive.SubTrigger>
  )
}

function ContextMenuSubContent({
  className,
  collisionPadding = FLOATING_LAYER_EDGE_PX,
  widthRole = "command",
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent> & {
  widthRole?: FloatingMenuWidthRole
}) {
  return (
    <ContextMenuPrimitive.SubContent
      data-slot="context-menu-sub-content"
      data-floating-menu-width={widthRole}
      collisionPadding={collisionPadding}
      className={cn(
        "bg-card text-card-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[128px] origin-(--radix-context-menu-content-transform-origin) overflow-hidden rounded-1 border p-1 shadow-md",
        className
      )}
      {...props}
    />
  )
}

function ContextMenuContent({
  className,
  collisionPadding = FLOATING_LAYER_EDGE_PX,
  widthRole = "command",
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content> & {
  widthRole?: FloatingMenuWidthRole
}) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        data-slot="context-menu-content"
        data-floating-menu-width={widthRole}
        collisionPadding={collisionPadding}
        className={cn(
          "bg-card text-card-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 max-h-(--radix-context-menu-content-available-height) min-w-[128px] origin-(--radix-context-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-1 border p-1 shadow-md",
          className
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  inset?: boolean
  variant?: "default" | "destructive" | "detach"
}) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "focus:state-active focus:text-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:[&_svg]:!text-destructive data-[variant=detach]:text-detach data-[variant=detach]:focus:text-detach data-[variant=detach]:[&_svg]:!text-detach [&_svg:not([class*='text-'])]:text-muted-foreground focus:[&_svg:not([class*='text-'])]:text-foreground relative flex cursor-default items-center gap-2 rounded-1 px-2 py-1.5 text-base outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:text-tertiary-foreground data-[disabled]:[&_svg:not([class*='text-'])]:text-tertiary-foreground data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[13px]",
        className
      )}
      {...props}
    />
  )
}

function ContextMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.CheckboxItem>) {
  return (
    <ContextMenuPrimitive.CheckboxItem
      data-slot="context-menu-checkbox-item"
      className={cn(
        "focus:state-active focus:text-foreground relative flex cursor-default items-center gap-2 rounded-1 py-1.5 pr-2 pl-8 text-base outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:text-tertiary-foreground data-[disabled]:[&_svg:not([class*='text-'])]:text-tertiary-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[13px]",
        className
      )}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <ContextMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-[13px]" />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  )
}

// Same row as DropdownMenuRadioItem: a check in the leading icon slot.
function ContextMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioItem>) {
  return (
    <ContextMenuPrimitive.RadioItem
      data-slot="context-menu-radio-item"
      className={cn(
        "focus:state-active focus:text-foreground relative flex cursor-default items-center gap-2 rounded-1 px-2 py-1.5 text-base outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:text-tertiary-foreground data-[disabled]:[&_svg:not([class*='text-'])]:text-tertiary-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className
      )}
      {...props}
    >
      <MenuIconSlot>
        <ContextMenuPrimitive.ItemIndicator className="flex">
          <CheckIcon className="size-[13px]" />
        </ContextMenuPrimitive.ItemIndicator>
      </MenuIconSlot>
      {children}
    </ContextMenuPrimitive.RadioItem>
  )
}

function ContextMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label> & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.Label
      data-slot="context-menu-label"
      data-inset={inset}
      className={cn(
        "text-foreground px-2 py-1.5 text-base font-semibold data-[inset]:pl-8",
        className
      )}
      {...props}
    />
  )
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn("bg-border -mx-1 my-1 h-px", className)}
      {...props}
    />
  )
}

function ContextMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="context-menu-shortcut"
      className={cn(
        "text-muted-foreground ml-auto text-sm tracking-widest",
        className
      )}
      {...props}
    />
  )
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuRadioGroup,
}
