import { useCallback, useEffect, useMemo, useRef } from "react";
import { useDndContext } from "@dnd-kit/core";
import { HoverIntent, type HoverIntentState } from "@/lib/hoverIntent";

/** Why a surface is not answering the pointer right now (С7.8). */
export type HoverIntentSuspension = "window" | "drag" | "menu" | "context-menu";

export interface HoverIntentHandle {
  /** Report the pointer over the surface above `target` (or a gap). */
  move(target: string | null, x: number, y: number): void;
  leave(): void;
  /** Content moved under the pointer: a scroll step or a reflow. */
  displace(): void;
  suspend(reason: HoverIntentSuspension, suspended: boolean): void;
  isSlow(): boolean;
  current(): HoverIntentState;
}

/**
 * One hover-intent engine for one surface, the feed or the sidebar
 * (SPEC_CARD_STATES.md, С7). `onChange` receives the calmed answers; the
 * window losing focus clears them and holds new ones until it returns.
 * Render `<HoverIntentDragWatch>` inside the surface to hold them during a
 * drag as well.
 */
export function useHoverIntent(onChange: (state: HoverIntentState) => void): HoverIntentHandle {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const engineRef = useRef<HoverIntent | null>(null);
  const reasonsRef = useRef(new Set<HoverIntentSuspension>());

  const engine = useCallback(() => {
    if (!engineRef.current) {
      engineRef.current = new HoverIntent((state) => onChangeRef.current(state));
    }
    return engineRef.current;
  }, []);

  const suspend = useCallback((reason: HoverIntentSuspension, suspended: boolean) => {
    const reasons = reasonsRef.current;
    if (suspended) reasons.add(reason);
    else reasons.delete(reason);
    engine().setSuspended(reasons.size > 0);
  }, [engine]);

  useEffect(() => {
    const onBlur = () => suspend("window", true);
    const onFocus = () => suspend("window", false);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      engineRef.current?.dispose();
    };
  }, [suspend]);

  return useMemo(() => ({
    move: (target, x, y) => engine().move(target, x, y),
    leave: () => engine().leave(),
    displace: () => engine().displace(),
    suspend,
    isSlow: () => engine().isSlow(),
    current: () => engine().state,
  }), [engine, suspend]);
}

/**
 * Holds a surface's answers while anything is being dragged. A separate
 * component so the drag context, which changes on every pointer step of a
 * drag, re-renders only this and not the surface.
 */
export function HoverIntentDragWatch({ intent }: { intent: HoverIntentHandle }) {
  const dragging = useDndContext().active !== null;
  useEffect(() => {
    intent.suspend("drag", dragging);
  }, [dragging, intent]);
  return null;
}
