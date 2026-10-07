import { useRef, useCallback, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

// The divider between the sidebar and the feed is the handle itself, built as
// the source design system's sidebar rail is (shadcn `SidebarRail`; user's
// decision of 07.10.2026): a 16px catch on the sidebar's 1px line and a 2px
// line drawn over it. The rail only toggles; this one resizes the panel
// between its minimum and maximum width and never collapses it, which the
// sidebar button and its hotkey do.
//
// The line runs through two boxes, the top row and the body, so the catch is
// laid in each of them and takes its height from the box: whatever height the
// top row has, and whatever bar stands below the body, the catch covers the
// line and nothing else (user's report of 07.10.2026: a catch of fixed heights
// missed the tall top row and crossed the bottom bar).

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
  /** The top row the line runs through above the body. The body's part is
   *  rendered in place, so its parent must be the positioned body. */
  topRowHost: HTMLElement | null;
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
  topRowHost,
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
  // One line runs through both parts, so the pointer over either lights both.
  const [pointerOver, setPointerOver] = useState(false);
  const [pressed, setPressed] = useState(false);

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
      setPressed(true);
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
      setPressed(false);
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
  // The line lights by the least shift, half a quiet step brighter than
  // itself (`--sidebar-border-hover`, SPEC_COLOR_RULES.md, 3.5; user's
  // decision of 07.10.2026). A pointer that only passes over the catch lights
  // nothing: the light waits 300ms, as a split view's sash does, then fades in.
  // A press, a drag and a keyboard focus light it with no wait; leaving fades
  // it out with no wait.
  const held = pressed || isResizing;
  const catchClassName = cn(
    "absolute z-40 outline-hidden",
    "after:absolute after:inset-y-0 after:left-1/2 after:w-[2px]",
    "after:transition-[background-color] after:duration-[180ms] after:ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:after:duration-0",
    "focus-visible:after:bg-ring focus-visible:after:delay-0",
    disabled && "pointer-events-none",
    !disabled && held && "after:bg-sidebar-border-hover",
    !disabled && !held && pointerOver && "after:bg-sidebar-border-hover after:delay-300",
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

  return (
    <>
      {/* Top row part: down through the row's separator, so the lit line
          meets the body's part without a gap. */}
      {topRowHost && createPortal(
        <div
          aria-hidden="true"
          data-sidebar-resize-handle=""
          className={catchClassName}
          style={{ top: 0, bottom: -1, left: CATCH_LEFT, width: CATCH_WIDTH }}
          {...pointerHandlers}
        />,
        topRowHost,
      )}
      {/* Body part, the one the keyboard reaches. */}
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
        style={{ top: 0, bottom: 0, left: CATCH_LEFT, width: CATCH_WIDTH }}
        onKeyDown={handleKeyDown}
        {...pointerHandlers}
      />
    </>
  );
}
