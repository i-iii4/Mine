import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { DropdownMenuPortalContainerProvider } from "@/components/ui/dropdown-menu";
import { usePressDragGesture, type PressDragOrigin } from "@/hooks/usePressDragGesture";
import { cn } from "@/lib/utils";
import { PopupApp } from "./PopupApp";
import { wrapTabFocus } from "./lib/focusCycle";
import { ClipperEditsContext, type ClipperEdits } from "./lib/clipperEdits";
import { OpenClipContext, type OpenClip } from "./lib/openClip";
import {
  DEFAULT_OVERLAY_BOUNDS,
  dragOverlay,
  fitOverlay,
  OVERLAY_BOUNDS_KEY,
  OVERLAY_CORNERS,
  resizeOverlay,
  type OverlayBounds,
  type OverlayCorner,
  type OverlayFrame,
  type Viewport,
} from "./lib/overlayBounds";

// Controls inside the header keep their own press. A control marked
// `data-clipper-drag-control` (the space's name) is part of the header the
// person grabs: a press on it moves the panel past the threshold and stays
// its own click without it. The "…" and close buttons stay plain buttons.
const HEADER_CONTROLS = "button, input, textarea, select, a[href], [role='button'], [role='menuitem'], [data-slot='dropdown-menu-trigger']";

/** Each corner's place on the panel and its cursor: the diagonal it resizes along. */
const CORNER_CLASSES: Record<OverlayCorner, string> = {
  "top-left": "left-0 top-0 cursor-nwse-resize",
  "top-right": "right-0 top-0 cursor-nesw-resize",
  "bottom-left": "bottom-0 left-0 cursor-nesw-resize",
  "bottom-right": "bottom-0 right-0 cursor-nwse-resize",
};

function readViewport(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

function isOverlayCorner(value: string | null): value is OverlayCorner {
  return OVERLAY_CORNERS.some((corner) => corner === value);
}

/** Whether a press may move the panel: anywhere in its header but the
 *  header's own controls, except the ones marked to move it. */
function startsHeaderDrag(event: ReactPointerEvent<HTMLElement>): boolean {
  const target = event.target;
  if (!(target instanceof Element) || !target.closest("[data-clipper-drag-handle]")) return false;
  const control = target.closest(HEADER_CONTROLS);
  return control === null || control.hasAttribute("data-clipper-drag-control");
}

/** Where a move or a resize started: the frame drawn then. */
interface GestureStart {
  frame: OverlayFrame;
  drawnHeight: number;
}

/** A press on a corner, followed until the pointer lets go. */
interface ResizeGesture extends GestureStart {
  corner: OverlayCorner;
  pointerId: number;
  x: number;
  y: number;
}

/**
 * Container for the in-page overlay version of the clipper.
 *
 * Place and size: the top right corner at the width of the detached popup
 * (360px) until the person drags the header or a corner; then where they put
 * it, kept between openings and fitted into the window (SPEC_CLIPPER.md,
 * «Доработки после живого просмотра», Р10). The header moves the panel by the
 * window chrome's rule of the app (usePressDragGesture.ts, the core of
 * useChromeDragGesture.ts): a press anywhere in it, the space's name
 * included, drags past 4 px and stays a click without it. A corner resizes
 * at once and keeps the opposite corner where it was. Border and shadow
 * follow the design system for floating elements (DESIGN_SYSTEM.md →
 * "Всплывающие элементы").
 *
 * Close behaviour: only the close button in the editor's header and Save
 * close it; a click outside goes to the page (Р5).
 *
 * pointer-events: the shadow host has pointer-events:none so clicks on
 * the empty viewport pass through to the page. The OverlayShell root
 * div explicitly opts its subtree back IN via pointer-events-auto.
 *
 * Focus: the panel does not take the keyboard when it opens; it gets it
 * when clicked (tabindex=-1). Tab and Shift+Tab then move between the
 * panel's controls and wrap at its edges instead of falling into the page
 * behind it (А6.9). A hide for a screenshot or a crop gives the keyboard
 * back to the panel on resume when the panel had it (overlay-entry.tsx,
 * Б4.9).
 */
export function OverlayShell({ portalContainer, edits, restored = null, initialBounds = DEFAULT_OVERLAY_BOUNDS }: {
  portalContainer: HTMLElement | null;
  edits: ClipperEdits;
  /** The clip this overlay reopens after its page changed (SPEC_CLIPPER.md, Р7). */
  restored?: OpenClip | null;
  /** The place and size kept from earlier openings. */
  initialBounds?: OverlayBounds;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState<OverlayBounds>(initialBounds);
  const [viewport, setViewport] = useState<Viewport>(readViewport);
  // The panel's height while it follows its content: it decides how far up a
  // panel near the bottom has to move.
  const [contentHeight, setContentHeight] = useState(0);
  const resizeRef = useRef<ResizeGesture | null>(null);
  const moveRef = useRef<GestureStart | null>(null);
  // The bounds a gesture builds on and ends with, ahead of the render.
  const boundsRef = useRef(bounds);
  useEffect(() => {
    boundsRef.current = bounds;
  }, [bounds]);

  useEffect(() => {
    const onResize = () => setViewport(readViewport());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const panel = ref.current;
    if (!panel || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setContentHeight(panel.getBoundingClientRect().height));
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  const frame = fitOverlay(bounds, viewport, contentHeight);

  // The frame drawn now: what a move or a resize starts from.
  const gestureStart = useCallback((): GestureStart => {
    const measured = ref.current?.getBoundingClientRect().height ?? 0;
    const start = fitOverlay(boundsRef.current, readViewport(), measured);
    return { frame: start, drawnHeight: start.height ?? measured };
  }, []);

  const apply = useCallback((next: OverlayBounds) => {
    boundsRef.current = next;
    setBounds(next);
  }, []);

  // The place and size the person set are kept for the next opening, in any
  // tab; the window never changes them.
  const keep = useCallback(() => {
    void chrome.storage.local.set({ [OVERLAY_BOUNDS_KEY]: boundsRef.current })
      .catch((cause) => console.warn("[Mine] overlay place kept for this opening only:", cause));
  }, []);

  const startMove = useCallback((event: PointerEvent) => {
    ref.current?.setPointerCapture?.(event.pointerId);
    moveRef.current = gestureStart();
  }, [gestureStart]);

  const followMove = useCallback((event: PointerEvent, origin: PressDragOrigin) => {
    const start = moveRef.current;
    if (!start) return;
    apply(dragOverlay(boundsRef.current, start.frame, start.drawnHeight,
      event.clientX - origin.startX, event.clientY - origin.startY, readViewport()));
  }, [apply]);

  const endMove = useCallback((event: PointerEvent) => {
    moveRef.current = null;
    ref.current?.releasePointerCapture?.(event.pointerId);
    keep();
  }, [keep]);

  const headerDrag = usePressDragGesture({
    shouldStart: startsHeaderDrag,
    onDragStart: startMove,
    onDragMove: followMove,
    onDragEnd: endMove,
  });

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !ref.current || !(event.target instanceof Element)) return;
    const corner = event.target.closest("[data-clipper-resize-handle]")?.getAttribute("data-clipper-resize-handle") ?? null;
    if (!isOverlayCorner(corner)) return;
    event.preventDefault();
    ref.current.setPointerCapture?.(event.pointerId);
    resizeRef.current = { ...gestureStart(), corner, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  }, [gestureStart]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = resizeRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    apply(resizeOverlay(gesture.frame, gesture.drawnHeight, gesture.corner,
      event.clientX - gesture.x, event.clientY - gesture.y, readViewport()));
  }, [apply]);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = resizeRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    ref.current?.releasePointerCapture?.(event.pointerId);
    keep();
  }, [keep]);

  return (
    <DropdownMenuPortalContainerProvider container={portalContainer}>
      <div
        ref={ref}
        data-mine-clipper-panel
        data-clipper-sized={frame.height === null ? undefined : "true"}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== "Tab" || event.metaKey || event.ctrlKey || event.altKey) return;
          const panel = ref.current;
          if (!panel) return;
          const root = panel.getRootNode() as Document | ShadowRoot;
          const target = wrapTabFocus(panel, root.activeElement, event.shiftKey);
          if (!target) return;
          event.preventDefault();
          target.focus({ preventScroll: true });
        }}
        onPointerDownCapture={headerDrag.onPointerDownCapture}
        onClickCapture={headerDrag.onClickCapture}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        // The panel stays inside the window: by content up to the window's
        // height less the 16px margins, or at the height the person set. The
        // flex column lets the elastic previews compress while buttons,
        // picker and the save stack keep their heights; below the sum of the
        // hard minimums (~430px) the inner column scrolls as a whole instead
        // of clipping. Shadow is the system floating-element shadow, not a
        // bespoke rgba.
        style={{
          left: frame.left,
          top: frame.top,
          width: frame.width,
          ...(frame.height === null ? { maxHeight: frame.maxHeight } : { height: frame.height }),
        }}
        className="pointer-events-auto fixed flex flex-col overflow-hidden rounded-1 border border-border bg-background shadow-md outline-none"
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <ClipperEditsContext.Provider value={edits}>
            <OpenClipContext.Provider value={restored}>
              <PopupApp />
            </OpenClipContext.Provider>
          </ClipperEditsContext.Provider>
        </div>
        {/* The corners the person drags to resize; the cursor is their only
            sign. The top ones lie over the header by their 16 px, under its
            "…" and close buttons (VaultSelect.tsx, StandaloneSetup.tsx). */}
        {OVERLAY_CORNERS.map((corner) => (
          <div key={corner} data-clipper-resize-handle={corner} aria-hidden="true" className={cn("absolute size-4", CORNER_CLASSES[corner])} />
        ))}
      </div>
    </DropdownMenuPortalContainerProvider>
  );
}
