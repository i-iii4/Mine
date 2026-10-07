import { useRef, useCallback, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/utils";

// The divider between the sidebar and the feed is the handle itself, looking
// and answering the pointer as the source design system's sidebar rail does
// (shadcn `SidebarRail`; user's decision of 07.10.2026): a 16px catch on the
// sidebar's 1px line, and a 2px line in the line's own colour while the
// pointer is over it. The rail only toggles; this one resizes the panel
// between its minimum and maximum width and never collapses it, which the
// sidebar button and its hotkey do.

// Both top chrome bars are h-8 (32px). The visible sidebar/main divider runs
// through the TOP menu and the BODY, but the SECONDARY (stats) bar in between
// has no visible line, so the catch covers the top band and the body band and
// skips the secondary bar's band entirely.
const TOP_MENU_HEIGHT = 32;
const SECONDARY_BAR_HEIGHT = 32;
/// The rail's catch, `w-4`. The rail sits in the sidebar's content box and is
/// pulled back by half its width, so its middle, where its 2px line starts,
/// falls on the sidebar's 1px right border, the last pixel inside
/// `--sidebar-width`: the catch spans 9px left of the sidebar's edge and 7px
/// right of it, and the lit line covers the border and the pixel past it.
const CATCH_WIDTH = 16;
const CATCH_LEFT = "calc(var(--sidebar-width) - 9px)";
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
  // One line runs through both bands, so the pointer over either lights both.
  const [pointerOver, setPointerOver] = useState(false);

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

  // The rail's cursor points where its edge can go; at a bound the line can
  // only go back.
  const cursorClassName =
    width <= minWidth ? "cursor-e-resize"
      : width >= maxWidth ? "cursor-w-resize"
        : "cursor-col-resize";
  const catchClassName = cn(
    "fixed z-40 outline-hidden after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] focus-visible:after:bg-ring",
    disabled && "pointer-events-none",
    !disabled && (pointerOver || isResizing) && "after:bg-sidebar-border",
    !isResizing && cursorClassName,
  );
  const pointerHandlers = {
    onPointerEnter: () => setPointerOver(true),
    onPointerLeave: () => setPointerOver(false),
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
