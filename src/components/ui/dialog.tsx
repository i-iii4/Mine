import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { ChromeCloseButton } from "@/components/ChromeCloseButton"
import { isMenuDismissPress } from "@/lib/openMenus"
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

/** What the content of a window tells its wrapper: whether it holds a
 *  `DialogCancel`, and so whether the close button stands in the title's
 *  line (DESIGN_SYSTEM.md, «Окна»). */
type DialogCancelSlot = {
  showsClose: boolean
  setHasCancel: (hasCancel: boolean) => void
}

const DialogCancelSlotContext = React.createContext<DialogCancelSlot | null>(null)

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(MODAL_OVERLAY_CLASS, className)}
      {...props}
    />
  )
}

// A window with content by default (DESIGN_SYSTEM.md, «Окна»): every Dialog
// holds a field, a list or a choice. The close button stands only in a
// window without Cancel: Cancel and Escape close the rest, as a macOS sheet.
// `showCloseButton={false}` is the search panel's alone, which is no window.
function DialogContent({
  className,
  children,
  widthRole = "content",
  showCloseButton = true,
  overlayClassName,
  onPointerDownOutside,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  widthRole?: ModalWidth
  showCloseButton?: boolean
  overlayClassName?: string
}) {
  const [hasCancel, setHasCancel] = React.useState(false)
  const showsClose = showCloseButton && !hasCancel
  const slot = React.useMemo(() => ({ showsClose, setHasCancel }), [showsClose])
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        data-modal-width={widthRole}
        onPointerDownOutside={(event) => {
          // A press outside a menu open over the dialog closes the menu only.
          if (isMenuDismissPress(event.detail.originalEvent)) {
            event.preventDefault()
            return
          }
          onPointerDownOutside?.(event)
        }}
        className={cn(MODAL_SURFACE_CLASS, MODAL_WIDTH_CLASS[widthRole], className)}
        {...props}
      >
        <DialogCancelSlotContext.Provider value={slot}>
          {children}
        </DialogCancelSlotContext.Provider>
        {showsClose && (
          // The chrome's close button (DESIGN_SYSTEM.md, «Окна»), in the
          // title's line: its 24px plate centred on the title's 24px line,
          // its right edge on the window field like every other right edge.
          // Last in the DOM, so opening the window still focuses its first
          // field or button, not this.
          <div className="absolute top-6 right-6 flex h-6 items-center">
            <DialogPrimitive.Close asChild>
              <ChromeCloseButton />
            </DialogPrimitive.Close>
          </div>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

// A text action always has a body (DESIGN_SYSTEM.md, «Закон текстовой
// кнопки»): Cancel is `secondary`, framed, as `AlertDialogCancel`. Its
// presence takes the close button out of the window before the first paint.
function DialogCancel({
  className,
  variant = "secondary",
  size = "default",
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  const setHasCancel = React.useContext(DialogCancelSlotContext)?.setHasCancel
  React.useLayoutEffect(() => {
    if (!setHasCancel) return
    setHasCancel(true)
    return () => setHasCancel(false)
  }, [setHasCancel])
  return (
    <Button variant={variant} size={size} className={className} asChild>
      <DialogPrimitive.Close data-slot="dialog-cancel" {...props} />
    </Button>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(MODAL_HEADER_CLASS, className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(MODAL_FOOTER_CLASS, className)}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="secondary">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  const showsClose = React.useContext(DialogCancelSlotContext)?.showsClose ?? false
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      // Room for the close button in the title's line, while it stands
      // there: its 24px plate and the 8px between them.
      className={cn(MODAL_TITLE_CLASS, showsClose && "pr-8", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(MODAL_DESCRIPTION_CLASS, className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogCancel,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
