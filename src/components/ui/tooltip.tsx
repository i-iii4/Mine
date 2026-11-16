"use client"

import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { FLOATING_LAYER_EDGE_PX, MENU_PLATE_GAP_PX, menuPlateOf, plateSideOffset } from "@/lib/floatingLayer"
import { MOTION_KEY_ATTRIBUTE, useMotionKeyRef } from "@/lib/motionInput"
import { onPointerLeftPage } from "@/lib/pointerLeftPage"
import { cn } from "@/lib/utils"

/** Whether a provider stands above: a tooltip without one brings its own,
 *  so a page that has none (the tab bar, tests, the clipper) still shows
 *  it. A shared provider lets the next tooltip open at once. */
const TooltipProviderPresent = React.createContext(false)

/** Whether the pointer drives this tooltip. One given `open` with no
 *  `onOpenChange` is a message (a name that cannot be saved): the pointer
 *  neither opens nor closes it. */
const TooltipPointerDriven = React.createContext(true)

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipProviderPresent.Provider value={true}>
      <TooltipPrimitive.Provider
        data-slot="tooltip-provider"
        delayDuration={delayDuration}
        {...props}
      />
    </TooltipProviderPresent.Provider>
  )
}

function Tooltip(props: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const provided = React.useContext(TooltipProviderPresent)
  const pointerDriven = !(props.open !== undefined && props.onOpenChange === undefined)
  const root = (
    <TooltipPointerDriven.Provider value={pointerDriven}>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipPointerDriven.Provider>
  )
  return provided ? root : <TooltipProvider>{root}</TooltipProvider>
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

/** The event every Radix tooltip closes on, by its own way of closing
 *  (`TOOLTIP_OPEN` in @radix-ui/react-tooltip): its provider then starts the
 *  delay of the next tooltip again, as after any close. Radix sends it when a
 *  tooltip opens; it has no other way to close a tooltip from outside. A
 *  test with the real Radix keeps the name true. */
const RADIX_TOOLTIP_OPEN_EVENT = "tooltip.open"

/** The mark of a tooltip the next one took the place of: it is gone at
 *  once, its leaving unseen (global.css). */
const REPLACED_ATTRIBUTE = "data-tooltip-replaced"

/** The tooltips the pointer drives that are on the page. */
const pointerTooltips = new Set<HTMLElement>()
const pagesFollowed = new WeakSet<Document>()

function isOpen(content: HTMLElement): boolean {
  return content.getAttribute("data-state") !== "closed"
}

/** Radix lays its popper out off the page until it is placed. */
function placed(content: HTMLElement): boolean {
  const wrapper = content.parentElement
  return wrapper !== null && !wrapper.style.transform.includes("-200%")
}

/**
 * A tooltip opened: one still leaving goes at once (SPEC_MOTION_LEVELS.md,
 * М3), in the frame the new one shows in. Radix places the new one within a
 * frame or two of its opening, off the page till then; the leaving one stays
 * until then, so no frame shows none.
 */
function replaceLeavingTooltips(opened: HTMLElement): void {
  opened.removeAttribute(REPLACED_ATTRIBUTE)
  const hide = () => {
    if (!opened.isConnected || !isOpen(opened)) return
    for (const content of pointerTooltips) {
      if (content !== opened && content.ownerDocument === opened.ownerDocument && !isOpen(content)) {
        content.setAttribute(REPLACED_ATTRIBUTE, "")
      }
    }
  }
  if (placed(opened)) {
    hide()
    return
  }
  const view = opened.ownerDocument.defaultView
  let frames = 0
  const wait = () => {
    frames += 1
    if (placed(opened) || frames > 2) hide()
    else view?.requestAnimationFrame(wait)
  }
  view?.requestAnimationFrame(wait)
}

/** Follows a tooltip's opening on Radix's `data-state`. Returns the end. */
function followOpening(content: HTMLElement): () => void {
  const view = content.ownerDocument.defaultView
  if (!view || typeof view.MutationObserver !== "function") return () => undefined
  let open = isOpen(content)
  if (open) replaceLeavingTooltips(content)
  const observer = new view.MutationObserver(() => {
    const now = isOpen(content)
    if (now === open) return
    open = now
    if (now) {
      replaceLeavingTooltips(content)
      return
    }
    // Closed after the next one opened: it is that one's predecessor.
    const followed = [...pointerTooltips].some((other) => (
      other !== content && other.ownerDocument === content.ownerDocument && other.isConnected && isOpen(other)
    ))
    if (followed) content.setAttribute(REPLACED_ATTRIBUTE, "")
  })
  observer.observe(content, { attributes: true, attributeFilter: ["data-state"] })
  return () => observer.disconnect()
}

/**
 * A tooltip the pointer opened goes when the pointer leaves the page, out
 * of the window or on to another screen, however fast (SPEC_MOTION_LEVELS.md,
 * «Подсказка уходит, когда курсор покинул окно»). Radix closes a tooltip
 * whose button the pointer left only on a later move outside the way to the
 * tooltip, and a pointer outside the page sends no move. One the keyboard's
 * focus opened stays while the focus does.
 */
function followPointerLeavingPage(document: Document): void {
  if (pagesFollowed.has(document)) return
  pagesFollowed.add(document)
  onPointerLeftPage(() => {
    const opened = [...pointerTooltips].some((content) => (
      content.ownerDocument === document
      && content.isConnected
      && isOpen(content)
      && !content.hasAttribute(MOTION_KEY_ATTRIBUTE)
    ))
    if (opened) document.dispatchEvent(new CustomEvent(RADIX_TOOLTIP_OPEN_EVENT))
  }, document)
}

/** The button a tooltip names: the one Radix points at it with
 *  `aria-describedby`, while it is open. */
function tooltipTriggerOf(content: HTMLElement): HTMLElement | null {
  const id = content.querySelector('[role="tooltip"]')?.id
  const root = content.getRootNode()
  if (!id || !(root instanceof Document || root instanceof ShadowRoot)) return null
  for (const element of root.querySelectorAll<HTMLElement>("[aria-describedby]")) {
    if (element.getAttribute("aria-describedby")?.split(/\s+/).includes(id)) return element
  }
  return null
}

/**
 * A tooltip stands `MENU_PLATE_GAP_PX` off the visible plate of its button,
 * as a menu does (user's decision of 15.11.2026; DESIGN_SYSTEM.md,
 * «Отступ от кнопки»): Radix counts from the button's box, and a chrome
 * button's box is its whole row with the 24px plate centred inside. Measured
 * on every opening, by the menus' own rule (`plateSideOffset`). A tooltip
 * that flips to the other side keeps the gap: the plate stands as far from
 * the box's top as from its bottom.
 */
function useTooltipPlateOffset(surface: HTMLElement | null, side: React.ComponentProps<typeof TooltipPrimitive.Content>["side"]): number {
  const [offset, setOffset] = React.useState(MENU_PLATE_GAP_PX)
  React.useLayoutEffect(() => {
    if (!surface) return
    const trigger = tooltipTriggerOf(surface)
    if (!trigger) return
    const next = plateSideOffset(trigger.getBoundingClientRect(), menuPlateOf(trigger).getBoundingClientRect(), side ?? "top")
    setOffset((current) => (current === next ? current : next))
  }, [surface, side])
  return offset
}

// On the interface's own surface, as a menu is: the card fill, its border
// and shadow, the 3px radius; no arrow (decision of 03.10.2026). Below its
// control, as macOS shows tooltips (decision of 04.10.2026); Radix flips it
// up where there is no room below, 4 px off its button's visible plate, as a
// menu (useTooltipPlateOffset). The first one comes after its delay as a
// small surface: 150 ms both ways on the surface curve (SPEC_MOTION_LEVELS.md,
// М3). The next ones, which Radix opens `instant-open` with no delay while
// one was just shown, stand at once, with no appearance, and the one before
// goes in that frame, with no fading (user's decision of 15.11.2026, after
// the motion guide). It answers the pointer: the same at every level (Р1). On
// the keyboard's focus it stands at once at every level (УД4). It moves by its
// animations alone: its duration class would otherwise give every property a
// transition, and the hiding of the one before would take 150 ms.
function TooltipContent({
  className,
  side = "bottom",
  sideOffset,
  collisionPadding = FLOATING_LAYER_EDGE_PX,
  children,
  ref,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  const pointerDriven = React.useContext(TooltipPointerDriven)
  const keyRef = useMotionKeyRef(ref)
  const [surface, setSurface] = React.useState<HTMLDivElement | null>(null)
  const plateOffset = useTooltipPlateOffset(surface, side)
  const attachedRef = React.useRef<{ node: HTMLElement; detach: () => void } | null>(null)
  // Radix hands the content's element to a new ref callback at each of its
  // renders, `null` first: the element is the same, so it stays followed; it
  // leaves the pointer's tooltips only once it has left the page.
  const contentRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      keyRef(node)
      if (node) setSurface(node)
      const attached = attachedRef.current
      if (!node) {
        if (attached) {
          queueMicrotask(() => {
            if (attachedRef.current !== attached || attached.node.isConnected) return
            attachedRef.current = null
            attached.detach()
          })
        }
        return
      }
      if (attached?.node === node) return
      attached?.detach()
      attachedRef.current = null
      if (!pointerDriven) return
      pointerTooltips.add(node)
      followPointerLeavingPage(node.ownerDocument)
      const stopFollowing = followOpening(node)
      attachedRef.current = {
        node,
        detach: () => {
          pointerTooltips.delete(node)
          stopFollowing()
        },
      }
    },
    [keyRef, pointerDriven],
  )
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={contentRef}
        data-slot="tooltip-content"
        data-tooltip-message={pointerDriven ? undefined : ""}
        side={side}
        sideOffset={sideOffset ?? plateOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "bg-card text-card-foreground transition-none animate-in fade-in-0 zoom-in-95 duration-(--motion-enter) ease-(--motion-surface-ease) data-[state=closed]:animate-out data-[state=closed]:duration-(--motion-enter) data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 flex w-fit items-center gap-2 origin-(--radix-tooltip-content-transform-origin) rounded-1 border px-2 py-1 text-sm text-balance shadow-md",
          className
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

/** The keystroke beside a tooltip's text, in the voice of the bottom bar's
 *  hotkeys. */
function TooltipShortcut({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="tooltip-shortcut"
      className={cn("rounded-1 bg-component-fill px-1 font-mono text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, TooltipShortcut }
