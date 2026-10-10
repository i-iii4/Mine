import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

/** Pointer travel that turns a press into a drag: the chrome's threshold
 *  gesture (SPEC_TABS.md, В60). Below it the press stays a click. */
export const DEFAULT_CHROME_DRAG_THRESHOLD_PX = 4;

/** Where the press that became a drag started. */
export interface PressDragOrigin {
  pointerId: number;
  startX: number;
  startY: number;
}

type PressDragState = PressDragOrigin & { dragging: boolean };

interface UsePressDragGestureOptions {
  disabled?: boolean;
  thresholdPx?: number;
  /** Whether this press may become a drag; any other keeps only its own press. */
  shouldStart?: (event: ReactPointerEvent<HTMLElement>) => boolean;
  /** The pointer passed the threshold: the press is a drag now, and the
   *  click that follows it is dropped. */
  onDragStart: (event: PointerEvent, origin: PressDragOrigin) => void;
  /** Every move of the dragging pointer, the one that started the drag included. */
  onDragMove?: (event: PointerEvent, origin: PressDragOrigin) => void;
  /** The dragging pointer let go or was cancelled. */
  onDragEnd?: (event: PointerEvent, origin: PressDragOrigin) => void;
}

/**
 * The chrome's press gesture without the window: a press caught on the
 * capture phase stays a plain press and click until the pointer travels past
 * the threshold; then it is a drag, and the click that follows is dropped.
 * The window chrome of Mine drags its window with it (useChromeDragGesture.ts),
 * the clipper's overlay drags its panel (SPEC_CLIPPER.md, Р10).
 */
export function usePressDragGesture({
  disabled = false,
  thresholdPx = DEFAULT_CHROME_DRAG_THRESHOLD_PX,
  shouldStart,
  onDragStart,
  onDragMove,
  onDragEnd,
}: UsePressDragGestureOptions) {
  const stateRef = useRef<PressDragState | null>(null);
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
    // A new press owns the click that follows it: a drag whose click never
    // came (a cancelled pointer) does not take this one.
    suppressClickRef.current = false;
    if (disabled || event.button !== 0 || event.defaultPrevented) return;
    if (shouldStart && !shouldStart(event)) return;

    cleanup();
    const origin: PressDragOrigin = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    stateRef.current = { ...origin, dragging: false };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const state = stateRef.current;
      if (!state || state.pointerId !== moveEvent.pointerId) return;
      if (state.dragging) {
        onDragMove?.(moveEvent, origin);
        return;
      }

      const dx = moveEvent.clientX - state.startX;
      const dy = moveEvent.clientY - state.startY;
      if (Math.hypot(dx, dy) < thresholdPx) return;

      state.dragging = true;
      suppressClickRef.current = true;
      moveEvent.preventDefault();
      moveEvent.stopPropagation();
      onDragStart(moveEvent, origin);
      onDragMove?.(moveEvent, origin);
    };

    const handlePointerEnd = (endEvent: PointerEvent) => {
      const state = stateRef.current;
      if (!state || state.pointerId !== endEvent.pointerId) return;
      cleanup();
      if (state.dragging) onDragEnd?.(endEvent, origin);
    };

    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("pointerup", handlePointerEnd, true);
    window.addEventListener("pointercancel", handlePointerEnd, true);
    cleanupRef.current = () => {
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerup", handlePointerEnd, true);
      window.removeEventListener("pointercancel", handlePointerEnd, true);
    };
  }, [cleanup, disabled, onDragEnd, onDragMove, onDragStart, shouldStart, thresholdPx]);

  return {
    onClickCapture: handleClickCapture,
    onPointerDownCapture: handlePointerDownCapture,
  };
}
