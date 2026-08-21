// Two-finger swipe: the decision arrives from the system, not from guesswork.
//
// The gesture used to be recognised here, from the stream of wheel events the
// web layer receives. That stream has no beginning and no end, and looks exactly
// like an ordinary scroll, so recognition meant thresholds on distance and
// silence — which fired late, dropped slow movements and ignored diagonals.
//
// AppKit knows the gesture's phases, so the shell recognises it there and emits
// `sidebar-swipe` with a direction. All that is left here is deciding whether
// that direction asks for something the panel is not already doing.

import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

export function useSidebarSwipe({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}): void {
  // A ref, so the subscription survives every change of panel state.
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const toggleRef = useRef(onToggle);
  toggleRef.current = onToggle;

  useEffect(() => {
    let cancelled = false;
    const unlisten = listen<string>("sidebar-swipe", (event) => {
      if (cancelled) return;
      const wantsOpen = event.payload === "right";
      if (wantsOpen === collapsedRef.current) toggleRef.current();
    });
    return () => {
      cancelled = true;
      void unlisten.then((fn) => fn());
    };
  }, []);
}
