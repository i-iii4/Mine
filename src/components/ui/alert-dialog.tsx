import * as React from "react"
import { AlertDialog as AlertDialogPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  MODAL_DESCRIPTION_CLASS,
  MODAL_FOOTER_CLASS,
  MODAL_HEADER_CLASS,
  MODAL_OVERLAY_CLASS,
  MODAL_SURFACE_CLASS,
  MODAL_TITLE_CLASS,
  MODAL_WIDTH_CLASS,
  type ModalWidth,
} from "@/components/ui/modal-window"

// A window that asks (DESIGN_SYSTEM.md, «Окна»): the same anatomy as Dialog,
// without the close button, since Cancel is its way out. A question by
// width, unless it shows what the action touches (a list, a preview).

function AlertDialog({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />
}

function AlertDialogTrigger({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  return (
    <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
  )
}

function AlertDialogPortal({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) {
  return (
    <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
  )
}

function AlertDialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn(MODAL_OVERLAY_CLASS, className)}
      {...props}
    />
  )
}

function AlertDialogContent({
  className,
  widthRole = "question",
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content> & {
  widthRole?: ModalWidth
}) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        data-modal-width={widthRole}
        className={cn(MODAL_SURFACE_CLASS, MODAL_WIDTH_CLASS[widthRole], className)}
        {...props}
      />
    </AlertDialogPortal>
  )
}

function AlertDialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn(MODAL_HEADER_CLASS, className)}
      {...props}
    />
  )
}

function AlertDialogFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(MODAL_FOOTER_CLASS, className)}
      {...props}
    />
  )
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn(MODAL_TITLE_CLASS, className)}
      {...props}
    />
  )
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn(MODAL_DESCRIPTION_CLASS, className)}
      {...props}
    />
  )
}

function AlertDialogAction({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  // The class goes to Button, which merges it with the variant's: on the
  // slotted child it would only be appended, and `text-detach` would lose
  // to the base `text-foreground` again.
  return (
    <Button variant={variant} size={size} className={className} asChild>
      <AlertDialogPrimitive.Action
        data-slot="alert-dialog-action"
        {...props}
      />
    </Button>
  )
}

// A text action always has a body (DESIGN_SYSTEM.md, «Закон текстовой
// кнопки»): Cancel is `secondary`, framed, never a bare `ghost` label.
function AlertDialogCancel({
  className,
  variant = "secondary",
  size = "default",
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <Button variant={variant} size={size} className={className} asChild>
      <AlertDialogPrimitive.Cancel
        data-slot="alert-dialog-cancel"
        {...props}
      />
    </Button>
  )
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
}
