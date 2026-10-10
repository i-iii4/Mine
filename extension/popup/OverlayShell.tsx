import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { DropdownMenuPortalContainerProvider } from "@/components/ui/dropdown-menu";
import { PopupApp } from "./PopupApp";
import { wrapTabFocus } from "./lib/focusCycle";
import { ClipperEditsContext, type ClipperEdits } from "./lib/clipperEdits";
import { OpenClipContext, type OpenClip } from "./lib/openClip";
import {
  DEFAULT_OVERLAY_BOUNDS,
  dragOverlay,
  fitOverlay,
  OVERLAY_BOUNDS_KEY,
  resizeOverlay,
  type OverlayBounds,
  type OverlayFrame,
  type Viewport,
} from "./lib/overlayBounds";

// Controls inside the header keep their own press: only its empty part drags.
const HEADER_CONTROLS = "button, input, textarea, select, a[href], [role='button'], [role='menuitem'], [data-slot='dropdown-menu-trigger']";

function readViewport(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

/** A press on the header or the corner, followed until the pointer lets go. */
interface Gesture {
  kind: "move" | "resize";
  pointerId: number;
  x: number;
  y: number;
  frame: OverlayFrame;
  drawnHeight: number;
}

/**
 * Container for the in-page overlay version of the clipper.
 *
 * Place and size: the top right corner at the width of the detached popup
 * (360px) until the person drags the header or the bottom right corner; then
 * where they put it, kept between openings and fitted into the window
 * (SPEC_CLIPPER.md, «Доработки после живого просмотра», Р10). Border and
 * shadow follow the design system for floating elements (DESIGN_SYSTEM.md →
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
  const gestureRef = useRef<Gesture | null>(null);
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

  const drawnHeight = useCallback(() => ref.current?.getBoundingClientRect().height ?? 0, []);

  const begin = useCallback((kind: Gesture["kind"], event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !ref.current) return;
    event.preventDefault();
    ref.current.setPointerCapture?.(event.pointerId);
    const measured = drawnHeight();
    const start = fitOverlay(boundsRef.current, readViewport(), measured);
    gestureRef.current = {
      kind, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      frame: start, drawnHeight: start.height ?? measured,
    };
  }, [drawnHeight]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest("[data-clipper-resize-handle]")) {
      begin("resize", event);
      return;
    }
    if (!target.closest("[data-clipper-drag-handle]") || target.closest(HEADER_CONTROLS)) return;
    begin("move", event);
  }, [begin]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    const view = readViewport();
    const next = gesture.kind === "move"
      ? dragOverlay(boundsRef.current, gesture.frame, gesture.drawnHeight, dx, dy, view)
      : resizeOverlay(gesture.frame, gesture.drawnHeight, dx, dy, view);
    boundsRef.current = next;
    setBounds(next);
  }, []);

  // The place and size the person set are kept for the next opening, in any
  // tab; the window never changes them.
  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    ref.current?.releasePointerCapture?.(event.pointerId);
    void chrome.storage.local.set({ [OVERLAY_BOUNDS_KEY]: boundsRef.current })
      .catch((cause) => console.warn("[Mine] overlay place kept for this opening only:", cause));
  }, []);

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
        {/* The corner the person drags to resize; the cursor is its only sign. */}
        <div data-clipper-resize-handle="" aria-hidden="true" className="absolute bottom-0 right-0 size-4 cursor-nwse-resize" />
      </div>
    </DropdownMenuPortalContainerProvider>
  );
}
