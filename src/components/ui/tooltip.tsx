"use client"

import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { FLOATING_LAYER_EDGE_PX } from "@/lib/floatingLayer"
import { MOTION_KEY_ATTRIBUTE, useMotionKeyRef } from "@/lib/motionInput"
import { onPointerLeftPage } from "@/lib/pointerLeftPage"
import { TooltipGlide } from "@/lib/tooltipGlide"
import { cn } from "@/lib/utils"

/** The provider above, with the glides of its tooltips (src/lib/tooltipGlide.ts):
 *  a shared provider lets the next tooltip open at once, and the next one of
 *  the same group glide there from its neighbour. `null`: the provider a
 *  tooltip with none above brings of its own, so a page that has none (the
 *  tab bar, tests, the clipper) still shows it, alone, as before: it has no
 *  neighbour to glide from and does not wait for one. `undefined`: no
 *  provider at all. */
const TooltipGlideContext = React.createContext<TooltipGlide | null | undefined>(undefined)

/** What a tooltip's trigger and content share: the trigger's element, and
 *  whether the pointer drives this tooltip. */
interface TooltipRootValue {
  triggerRef: React.RefObject<HTMLElement | null>
  glides: boolean
}
const TooltipRootContext = React.createContext<TooltipRootValue | null>(null)

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  const [glide] = React.useState(() => new TooltipGlide())
  React.useEffect(() => () => glide.dispose(), [glide])
  return (
    <TooltipGlideContext.Provider value={glide}>
      <TooltipPrimitive.Provider
        data-slot="tooltip-provider"
        delayDuration={delayDuration}
        {...props}
      />
    </TooltipGlideContext.Provider>
  )
}

function Tooltip(props: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const glide = React.useContext(TooltipGlideContext)
  if (glide !== undefined) return <TooltipRoot {...props} />
  return (
    <TooltipGlideContext.Provider value={null}>
      <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={0}>
        <TooltipRoot {...props} />
      </TooltipPrimitive.Provider>
    </TooltipGlideContext.Provider>
  )
}

/**
 * A tooltip given `open` with no `onOpenChange` is a message (a name that
 * cannot be saved): the pointer does not drive it, so it does not glide.
 */
function TooltipRoot(props: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const triggerRef = React.useRef<HTMLElement | null>(null)
  const glides = !(props.open !== undefined && props.onOpenChange === undefined)
  const root = React.useMemo<TooltipRootValue>(() => ({ triggerRef, glides }), [glides])
  return (
    <TooltipRootContext.Provider value={root}>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipRootContext.Provider>
  )
}

/** The event every Radix tooltip closes on, by its own way of closing
 *  (`TOOLTIP_OPEN` in @radix-ui/react-tooltip): its provider then starts the
 *  delay of the next tooltip again, as after any close. Radix sends it when a
 *  tooltip opens; it has no other way to close a tooltip from outside. A
 *  test with the real Radix keeps the name true. */
const RADIX_TOOLTIP_OPEN_EVENT = "tooltip.open"

/** The tooltips the pointer drives that are on the page. */
const pointerTooltips = new Set<HTMLElement>()
const pagesFollowed = new WeakSet<Document>()

/**
 * A tooltip the pointer opened goes when the pointer leaves the page, out
 * of the window or on to another screen, however fast (SPEC_MOTION_LEVELS.md,
 * «Подсказка уходит, когда курсор покинул окно»). Radix closes a tooltip
 * whose button the pointer left only on a later move outside the way to the
 * tooltip, and a pointer outside the page sends no move. One the keyboard's
 * focus opened stays while the focus does. It goes in a microtask, after the
 * glides of every provider have heard the pointer leave (tooltipGlide.ts):
 * its leaving then runs at once, with no wait for a neighbour.
 */
function followPointerLeavingPage(document: Document): void {
  if (pagesFollowed.has(document)) return
  pagesFollowed.add(document)
  onPointerLeftPage(() => {
    queueMicrotask(() => {
      const opened = [...pointerTooltips].some((content) => (
        content.ownerDocument === document
        && content.isConnected
        && content.getAttribute("data-state") !== "closed"
        && !content.hasAttribute(MOTION_KEY_ATTRIBUTE)
      ))
      if (opened) document.dispatchEvent(new CustomEvent(RADIX_TOOLTIP_OPEN_EVENT))
    })
  }, document)
}

function TooltipTrigger({
  ref,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  const root = React.useContext(TooltipRootContext)
  const triggerRef = React.useCallback(
    (node: HTMLButtonElement | null) => {
      if (root) root.triggerRef.current = node
      if (typeof ref === "function") ref(node)
      else if (ref) ref.current = node
    },
    [ref, root],
  )
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" ref={triggerRef} {...props} />
}

// On the interface's own surface, as a menu is: the card fill, its border
// and shadow, the 3px radius; no arrow (decision of 03.10.2026). Below its
// control, as macOS shows tooltips (decision of 04.10.2026); Radix flips it
// up where there is no room below. A small surface: 150 ms both ways on the
// surface curve (SPEC_MOTION_LEVELS.md, М3). It answers the pointer, so it
// moves the same at every level, and the next ones, which Radix opens
// `instant-open` with no delay, come the same way (Р1). The next one of the
// same group glides there from its neighbour instead (tooltipGlide.ts;
// user's decision of 15.11.2026). On the keyboard's focus it stands at once
// at every level (УД4).
//
// The text lies in a clip inside the frame's line, so a glide can clip it
// to a moving frame; the clip and the text add no box of their own at rest.
// It moves by its animations alone: its duration class would otherwise give
// every property a transition, and a glide's writes and the hiding of the
// neighbour it takes over from land in their frame.
function TooltipContent({
  className,
  side = "bottom",
  sideOffset = 4,
  collisionPadding = FLOATING_LAYER_EDGE_PX,
  children,
  ref,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  const glide = React.useContext(TooltipGlideContext)
  const root = React.useContext(TooltipRootContext)
  const keyRef = useMotionKeyRef(ref)
  const clipRef = React.useRef<HTMLSpanElement | null>(null)
  const innerRef = React.useRef<HTMLSpanElement | null>(null)
  const attachedRef = React.useRef<{ node: HTMLElement; detach: () => void } | null>(null)
  // Radix hands the content's element to a new ref callback at each of its
  // renders, `null` first: the element is the same, so it stays attached;
  // it leaves the glides and the pointer's tooltips only once it has left
  // the page.
  const contentRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      keyRef(node)
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
      const clip = clipRef.current
      const inner = innerRef.current
      if (!root?.glides) return
      pointerTooltips.add(node)
      followPointerLeavingPage(node.ownerDocument)
      const detachGlide = glide && clip && inner
        ? glide.attach({ content: node, clip, inner, trigger: () => root.triggerRef.current })
        : null
      attachedRef.current = {
        node,
        detach: () => {
          pointerTooltips.delete(node)
          detachGlide?.()
        },
      }
    },
    [glide, keyRef, root],
  )
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={contentRef}
        data-slot="tooltip-content"
        side={side}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "bg-card text-card-foreground transition-none animate-in fade-in-0 zoom-in-95 duration-(--motion-enter) ease-(--motion-surface-ease) data-[state=closed]:animate-out data-[state=closed]:duration-(--motion-enter) data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-fit origin-(--radix-tooltip-content-transform-origin) rounded-1 border text-sm text-balance shadow-md",
          className
        )}
        {...props}
      >
        <span ref={clipRef} data-tooltip-clip="" className="block">
          <span ref={innerRef} data-tooltip-text="" className="flex items-center gap-2 px-2 py-1">
            {children}
          </span>
        </span>
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
