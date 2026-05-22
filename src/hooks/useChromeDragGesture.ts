import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const DEFAULT_CHROME_DRAG_THRESHOLD_PX = 4;

type ChromeDragState = {
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
};

interface UseChromeDragGestureOptions {
  disabled?: boolean;
  thresholdPx?: number;
}

export function useChromeDragGesture({
  disabled = false,
  thresholdPx = DEFAULT_CHROME_DRAG_THRESHOLD_PX,
}: UseChromeDragGestureOptions = {}) {
  const stateRef = useRef<ChromeDragState | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const suppressClickRef = useRef(false);

  const cleanup = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    stateRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const handleClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handlePointerDownCapture = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (disabled || event.button !== 0 || event.defaultPrevented) return;

    cleanup();
    stateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const state = stateRef.current;
      if (!state || state.pointerId !== moveEvent.pointerId || state.dragging) return;

      const dx = moveEvent.clientX - state.startX;
      const dy = moveEvent.clientY - state.startY;
      if (Math.hypot(dx, dy) < thresholdPx) return;

      state.dragging = true;
      suppressClickRef.current = true;
      moveEvent.preventDefault();
      moveEvent.stopPropagation();
      void getCurrentWindow().startDragging().catch(() => {});
    };

    const handlePointerEnd = (endEvent: PointerEvent) => {
      const state = stateRef.current;
      if (!state || state.pointerId !== endEvent.pointerId) return;
      cleanup();
    };

    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("pointerup", handlePointerEnd, true);
    window.addEventListener("pointercancel", handlePointerEnd, true);
    cleanupRef.current = () => {
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerup", handlePointerEnd, true);
      window.removeEventListener("pointercancel", handlePointerEnd, true);
    };
  }, [cleanup, disabled, thresholdPx]);

  return {
    onClickCapture: handleClickCapture,
    onPointerDownCapture: handlePointerDownCapture,
  };
}
