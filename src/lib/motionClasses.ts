// src/lib/motionClasses.ts: Minimal's time and curve as Tailwind classes, for
// a transition whose start a component's own state decides
// (SPEC_MOTION_LEVELS.md, УД2). They apply under `data-motion="minimal"` on an
// ancestor, as every level rule does (НС6), and leave Full to the
// component's own classes. Off needs none: global.css lands every transition
// at once.

/** Minimal's curve, E (`--motion-ease`), for a transition that keeps its own
 *  time in Minimal. */
export const MINIMAL_EASE_CLASS = "[[data-motion=minimal]_&]:ease-[var(--motion-ease)]";

/** An appearance or a move to a new state in Minimal: `--motion-enter` on E. */
export const MINIMAL_ENTER_CLASS =
  "[[data-motion=minimal]_&]:duration-[var(--motion-enter)] [[data-motion=minimal]_&]:ease-[var(--motion-ease)]";

/** A leaving or a fade out in Minimal: `--motion-exit` on E. */
export const MINIMAL_EXIT_CLASS =
  "[[data-motion=minimal]_&]:duration-[var(--motion-exit)] [[data-motion=minimal]_&]:ease-[var(--motion-ease)]";

/** A fade shown or hidden by state in Minimal: in on the enter time, out on
 *  the exit time. */
export function minimalFadeClass(shown: boolean): string {
  return shown ? MINIMAL_ENTER_CLASS : MINIMAL_EXIT_CLASS;
}
