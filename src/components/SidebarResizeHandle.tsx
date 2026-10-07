import { useRef, useCallback, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/utils";

// The divider between the sidebar and the feed is the handle itself, as the
// source design system's resizable handle is (shadcn `ResizableHandle`
// without its grip; user's decision of 07.10.2026). Nothing appears on it: the
// sidebar's own 1px line stays the only mark, a 4px catch straddles it, the
// pointer turns into `col-resize`, and a keyboard focus draws the ring. A drag
// resizes the panel between its minimum and maximum width; it never collapses
// the panel, which the sidebar button and its hotkey do.

// Both top chrome bars are h-8 (32px). The visible sidebar/main divider runs
// through the TOP menu and the BODY, but the SECONDARY (stats) bar in between
// has no visible line, so the catch covers the top band and the body band and
// skips the secondary bar's band entirely.
const TOP_MENU_HEIGHT = 32;
const SECONDARY_BAR_HEIGHT = 32;
/// The catch round the line, shadcn's `after:w-1`. The line is the sidebar's
/// right border, the last pixel inside its width, so the catch is centred on
/// that pixel.
const CATCH_WIDTH = 4;
const CATCH_LEFT = `calc(var(--sidebar-width) - ${CATCH_WIDTH / 2 + 0.5}px)`;
/// A drag starts past this travel, so a press that wanders by a pixel or two
/// does not nudge the width.
const DRAG_THRESHOLD = 4;
/// One arrow key press moves the line by the spacing step.
const KEYBOARD_STEP_PX = 16;

interface SidebarResizeHandleProps {
  isResizing: boolean;
  /** Whether the secondary (stats) bar is shown: its band is skipped. */
  secondaryBarVisible: boolean;
  /** The panel's width now and its bounds, for the separator's value. */
  width: number;
  minWidth: number;
  maxWidth: number;
  disabled: boolean;
  onResizeStart: (startX: number, startWidth: number) => void;
  onResizeUpdate: (clientX: number) => void;
  onResizeEnd: () => void;
  /** Set the width from the keyboard; the hook clamps it. */
  onResizeTo: (width: number) => void;
}

function clearNativeSelection(): void {
  document.getSelection()?.removeAllRanges();
}

export function SidebarResizeHandle({
  isResizing,
  secondaryBarVisible,
  width,
  minWidth,
  maxWidth,
  disabled,
  onResizeStart,
  onResizeUpdate,
  onResizeEnd,
  onResizeTo,
}: SidebarResizeHandleProps) {
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const didDragRef = useRef(false);

  const handlePointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (disabled || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      // WebKit selection is held off from the press itself, not from the
      // drag threshold (SPEC_FRONTEND.md, «Sidebar Resize»).
      clearNativeSelection();
      document.body.classList.add("sidebar-resizing");
      e.currentTarget.setPointerCapture(e.pointerId);
      startXRef.current = e.clientX;
      startWidthRef.current = width;
      didDragRef.current = false;
    },
    [disabled, width],
  );

  const handlePointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      e.preventDefault();
      const delta = e.clientX - startXRef.current;
      if (!didDragRef.current && Math.abs(delta) > DRAG_THRESHOLD) {
        didDragRef.current = true;
        clearNativeSelection();
        onResizeStart(startXRef.current, startWidthRef.current);
      }
      if (didDragRef.current) onResizeUpdate(e.clientX);
    },
    [onResizeStart, onResizeUpdate],
  );

  const finishPointer = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      if (didDragRef.current) onResizeEnd();
      else document.body.classList.remove("sidebar-resizing");
      didDragRef.current = false;
    },
    [onResizeEnd],
  );

  // The separator pattern: arrows move the line a step, Home and End take it
  // to its bounds. The keys stay here, so the feed does not move its focus.
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (disabled || e.metaKey || e.ctrlKey || e.altKey) return;
      const next =
        e.key === "ArrowLeft" ? width - KEYBOARD_STEP_PX
          : e.key === "ArrowRight" ? width + KEYBOARD_STEP_PX
            : e.key === "Home" ? minWidth
              : e.key === "End" ? maxWidth
                : null;
      if (next === null) return;
      e.preventDefault();
      e.stopPropagation();
      onResizeTo(next);
    },
    [disabled, maxWidth, minWidth, onResizeTo, width],
  );

  const catchClassName = cn(
    "fixed z-40 outline-hidden focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1",
    disabled && "pointer-events-none",
    !isResizing && "cursor-col-resize",
  );
  const pointerHandlers = {
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: finishPointer,
    onPointerCancel: finishPointer,
  };
  const bodyTop = secondaryBarVisible ? TOP_MENU_HEIGHT + SECONDARY_BAR_HEIGHT : TOP_MENU_HEIGHT;

  return (
    <>
      {/* Top menu band: the line is visible here, so it can be grabbed. */}
      <div
        aria-hidden="true"
        data-sidebar-resize-handle=""
        className={catchClassName}
        style={{ top: 0, height: TOP_MENU_HEIGHT, left: CATCH_LEFT, width: CATCH_WIDTH }}
        {...pointerHandlers}
      />
      {/* Body band: below the secondary (stats) bar, whose band has no line.
          The one the keyboard reaches. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={Math.round(width)}
        aria-valuemin={Math.round(minWidth)}
        aria-valuemax={Math.round(maxWidth)}
        tabIndex={disabled ? -1 : 0}
        data-sidebar-resize-handle=""
        className={catchClassName}
        style={{ top: bodyTop, bottom: 0, left: CATCH_LEFT, width: CATCH_WIDTH }}
        onKeyDown={handleKeyDown}
        {...pointerHandlers}
      />
    </>
  );
}
