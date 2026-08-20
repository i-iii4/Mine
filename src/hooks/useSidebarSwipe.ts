// Two-finger horizontal swipe opens and closes the sidebar.
//
// On macOS a trackpad swipe arrives as `wheel` events carrying `deltaX`; there
// is no separate gesture event for it. That makes the whole problem one of
// telling a deliberate sideways swipe from the sideways noise every vertical
// scroll produces — a finger never travels in a perfectly straight line.
//
// Three guards do that, and all three are needed:
//
//  1. Direction. The run only counts while horizontal travel dominates the
//     vertical one; a diagonal flick through the feed is not a swipe.
//  2. Distance. A short nudge does nothing. The threshold is the whole
//     protection against the panel flapping while someone scrolls.
//  3. Rest. After firing, the gesture is spent until the trackpad goes quiet —
//     inertia keeps delivering events long after the fingers lift, and without
//     this one flick would toggle the panel several times over.

import { useEffect, useRef } from "react";

/// Horizontal travel that makes a swipe, in wheel units (≈ pixels).
const SWIPE_DISTANCE = 80;
/// How much the horizontal component must beat the vertical one.
const DIRECTION_RATIO = 1.5;
/// Silence that ends a gesture, in milliseconds. Trackpad inertia arrives in a
/// steady stream, so anything shorter re-arms mid-flick.
const REST_MS = 220;

export function useSidebarSwipe({
  collapsed,
  onToggle,
  disabled = false,
}: {
  collapsed: boolean;
  onToggle: () => void;
  disabled?: boolean;
}): void {
  // Refs, not state: a gesture must not re-render anything while it runs.
  const travelRef = useRef(0);
  const spentRef = useRef(false);
  const lastEventRef = useRef(0);
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;

  useEffect(() => {
    if (disabled) return;

    const onWheel = (event: WheelEvent) => {
      const now = event.timeStamp;
      if (now - lastEventRef.current > REST_MS) {
        travelRef.current = 0;
        spentRef.current = false;
      }
      lastEventRef.current = now;

      if (spentRef.current) return;

      const { deltaX, deltaY } = event;
      if (Math.abs(deltaX) < Math.abs(deltaY) * DIRECTION_RATIO) {
        // Vertical scrolling with sideways noise: not this gesture, and the run
        // resets so the noise cannot accumulate into one.
        travelRef.current = 0;
        return;
      }

      travelRef.current += deltaX;
      if (Math.abs(travelRef.current) < SWIPE_DISTANCE) return;

      // Natural scrolling: fingers moving right report negative deltaX. Right
      // opens the panel, left closes it — the panel follows the fingers.
      const wantsOpen = travelRef.current < 0;
      spentRef.current = true;
      travelRef.current = 0;
      if (wantsOpen === collapsedRef.current) onToggle();
    };

    window.addEventListener("wheel", onWheel, { passive: true });
    return () => window.removeEventListener("wheel", onWheel);
  }, [disabled, onToggle]);
}
