// One setting for motion: the system's "Reduce motion" (SPEC_AUDIT_FIXES.md,
// Ф12). CSS follows it through `@media (prefers-reduced-motion: reduce)` in
// global.css; code that animates itself asks here, so a menu, a scroll, the
// image zoom and the graph camera all obey the same switch.

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** How long a programmatic movement lasts: none when motion is reduced. */
export function motionDuration(ms: number): number {
  return prefersReducedMotion() ? 0 : ms;
}

/** The scroll behavior for a programmatic scroll. */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}
