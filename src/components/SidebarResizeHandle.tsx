import { useRef, useState, useCallback } from "react";
import { cn } from "@/lib/utils";

const DRAG_THRESHOLD = 4;
const TITLEBAR_HEIGHT = 32;

interface SidebarResizeHandleProps {
  sidebarWidth: number;
  isResizing: boolean;
  disabled: boolean;
  onResizeStart: (startX: number, startWidth: number) => void;
  onResizeUpdate: (clientX: number) => void;
  onResizeEnd: () => void;
  onToggleCollapsed: () => void;
}

export function SidebarResizeHandle({
  sidebarWidth,
  isResizing,
  disabled,
  onResizeStart,
  onResizeUpdate,
  onResizeEnd,
  onToggleCollapsed,
}: SidebarResizeHandleProps) {
  const [hovered, setHovered] = useState(false);
  const startXRef = useRef(0);
  const didDragRef = useRef(false);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      startXRef.current = e.clientX;
      didDragRef.current = false;
    },
    [disabled],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      const delta = e.clientX - startXRef.current;

      if (!didDragRef.current && Math.abs(delta) > DRAG_THRESHOLD) {
        didDragRef.current = true;
        onResizeStart(startXRef.current, sidebarWidth);
      }
      if (didDragRef.current) {
        onResizeUpdate(e.clientX);
      }
    },
    [onResizeStart, onResizeUpdate, sidebarWidth],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      e.currentTarget.releasePointerCapture(e.pointerId);
      if (didDragRef.current) {
        onResizeEnd();
      } else {
        onToggleCollapsed();
      }
      didDragRef.current = false;
    },
    [onResizeEnd, onToggleCollapsed],
  );

  const showPill = hovered || isResizing;

  return (
    <div
      className={cn(
        "fixed z-40 flex items-center",
        disabled && "pointer-events-none",
        !isResizing && "cursor-col-resize",
      )}
      style={{
        top: TITLEBAR_HEIGHT,
        bottom: 0,
        left: sidebarWidth,
        width: 14,
      }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {/* Pill handle: 4px left zone + 6px gap + pill + 2px right */}
      <div
        className={cn(
          "h-10 w-1.5 rounded-full bg-border transition-opacity duration-150",
          showPill ? "opacity-100" : "opacity-0",
        )}
        style={{ marginLeft: 6 }}
      />
    </div>
  );
}
