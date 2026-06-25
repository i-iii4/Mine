import { useRef, useState, useCallback, useEffect } from "react";
import { cn } from "@/lib/utils";

const DRAG_THRESHOLD = 4;
// Both top chrome bars are h-8 (32px). The visible sidebar/main divider runs
// through the TOP menu and the BODY, but the SECONDARY (stats) bar in between
// has no visible line — so the hit zone and highlight cover the top band and
// the body band and skip the secondary bar's band entirely.
const TOP_MENU_HEIGHT = 32;
const SECONDARY_BAR_HEIGHT = 32;
// The pill stays to the RIGHT of the divider line (PILL_GAP) so that when the
// sidebar is collapsed (width → 0, line at x=0) it still sits on-screen as a
// grab tab. The hit zone, however, straddles the line: it extends LEFT_CATCH
// past the line on the sidebar side and far enough right to cover the pill.
// Both zone edges therefore land off the visible line — the natural aim point —
// which kills the boundary flicker, and gives real catch area on the left.
const LEFT_CATCH = 8;
const PILL_GAP = 6;
const PILL_WIDTH = 6; // w-1.5
const HANDLE_WIDTH = LEFT_CATCH + PILL_GAP + PILL_WIDTH + 2; // 22px, 2px right slack
const PILL_MARGIN_LEFT = LEFT_CATCH + PILL_GAP; // keep pill at line + PILL_GAP

interface SidebarResizeHandleProps {
  isResizing: boolean;
  /** Whether the secondary (stats) bar is shown — its band is skipped. */
  secondaryBarVisible: boolean;
  disabled: boolean;
  onResizeStart: (startX: number, startWidth: number) => void;
  onResizeUpdate: (clientX: number) => void;
  onResizeEnd: () => void;
  onToggleCollapsed: () => void;
}

function readSidebarWidth(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width");
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clearNativeSelection(): void {
  document.getSelection()?.removeAllRanges();
}

export function SidebarResizeHandle({
  isResizing,
  secondaryBarVisible,
  disabled,
  onResizeStart,
  onResizeUpdate,
  onResizeEnd,
  onToggleCollapsed,
}: SidebarResizeHandleProps) {
  const [hovered, setHovered] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const didDragRef = useRef(false);

  // Drop a stale hover when the handle is disabled mid-gesture (e.g. a block
  // drag begins): pointer-events:none means a pointerleave never arrives, so
  // the pill would otherwise stay lit.
  useEffect(() => {
    if (disabled) setHovered(false);
  }, [disabled]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) return;
      e.preventDefault();
      e.stopPropagation();
      clearNativeSelection();
      document.body.classList.add("sidebar-resizing");
      e.currentTarget.setPointerCapture(e.pointerId);
      startXRef.current = e.clientX;
      startWidthRef.current = readSidebarWidth();
      didDragRef.current = false;
    },
    [disabled],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      e.preventDefault();
      const delta = e.clientX - startXRef.current;

      if (!didDragRef.current && Math.abs(delta) > DRAG_THRESHOLD) {
        didDragRef.current = true;
        clearNativeSelection();
        onResizeStart(startXRef.current, startWidthRef.current);
      }
      if (didDragRef.current) {
        onResizeUpdate(e.clientX);
      }
    },
    [onResizeStart, onResizeUpdate],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      e.currentTarget.releasePointerCapture(e.pointerId);
      if (didDragRef.current) {
        onResizeEnd();
      } else {
        // A stationary click (no drag past threshold) toggles collapse/expand in
        // both directions — this is the peek-tab behaviour. Drag resizes; drag to
        // the edge collapses via endResize.
        document.body.classList.remove("sidebar-resizing");
        onToggleCollapsed();
      }
      didDragRef.current = false;
    },
    [onResizeEnd, onToggleCollapsed],
  );

  const handlePointerCancel = useCallback(
    (e: React.PointerEvent) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      if (didDragRef.current) {
        onResizeEnd();
      } else {
        document.body.classList.remove("sidebar-resizing");
      }
      didDragRef.current = false;
    },
    [onResizeEnd],
  );

  const showPill = !disabled && (hovered || isResizing);
  const bodyTop = secondaryBarVisible ? TOP_MENU_HEIGHT + SECONDARY_BAR_HEIGHT : TOP_MENU_HEIGHT;

  const stripClassName = cn(
    "fixed z-40 flex items-center",
    disabled && "pointer-events-none",
    !isResizing && "cursor-col-resize",
  );
  const stripHandlers = {
    onPointerEnter: () => setHovered(true),
    onPointerLeave: () => setHovered(false),
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
    onPointerCancel: handlePointerCancel,
  };
  const stripLeft = `calc(var(--sidebar-width) - ${LEFT_CATCH}px)`;

  return (
    <>
      {/* Top menu band: the line is visible here, so it stays resizable. */}
      <div
        className={stripClassName}
        style={{ top: 0, height: TOP_MENU_HEIGHT, left: stripLeft, width: HANDLE_WIDTH }}
        {...stripHandlers}
      />
      {/* Body band: starts below the secondary (stats) bar, so that bar's band —
          which has no visible line — is skipped. The pill lives here. */}
      <div
        className={stripClassName}
        style={{ top: bodyTop, bottom: 0, left: stripLeft, width: HANDLE_WIDTH }}
        {...stripHandlers}
      >
        {/* Pill sits to the right of the line (PILL_GAP). Stays put in both states:
            when collapsed the line is at x=0, so the pill is at x=PILL_GAP, on-screen. */}
        <div
          className={cn(
            "h-10 w-1.5 rounded-full bg-border transition-opacity duration-150",
            showPill ? "opacity-100" : "opacity-0",
          )}
          style={{ marginLeft: PILL_MARGIN_LEFT }}
        />
      </div>
    </>
  );
}
